// BEA-179 캘린더 차단 — 실제 PostgreSQL + Nest 앱으로 설계 09 "확인 기준"을 확인한다. 합성 데이터만(절대 규칙 8).
// 등록·제거(D3), 예약 등록·이동의 409 BLOCKED(Q1)와 예외(Q2·메모만), 조회 blocks·blockedBy(D5), 숨긴 담당자(D6),
// 두 연결의 커밋 순서(매장 쓰기 잠금 Q3), 매장 격리·RLS·지연 제약.
require('reflect-metadata');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { test, before, after } = require('node:test');
const { Module } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const { Client } = require('pg');
const { DatabaseService } = require('../dist/database.service.js');
const { ApiExceptionFilter } = require('../dist/common/api-exception.filter.js');
const { AppointmentM1Controller, CalendarM1Controller } = require('../dist/appointments-m1/appointment-m1.controller.js');
const { AppointmentM1Service } = require('../dist/appointments-m1/appointment-m1.service.js');
const { CalendarBlockController } = require('../dist/calendar-blocks/calendar-block.controller.js');
const { CalendarBlockService } = require('../dist/calendar-blocks/calendar-block.service.js');
const { signCookie } = require('../dist/owner-session.js');

const SECRET = 'ab'.repeat(32);
const env = {
  KAKAO_CLIENT_ID: 'test-app', KAKAO_CLIENT_SECRET: 'test-secret',
  KAKAO_REDIRECT_URI: 'https://example.test/api/auth/kakao/callback', BV_SESSION_SECRET: SECRET,
};
const savedEnv = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
const admin = new Client({ connectionString: process.env.DATABASE_MIGRATION_URL });
const [shopA, shopB, userA, userB, customerA, customerB, staffA, staffB, staffOff, staffOther] = Array.from({ length: 10 }, () => randomUUID());
let app;
let base;

before(async () => {
  Object.assign(process.env, env);
  await admin.connect();
  await admin.query("INSERT INTO crm.shop (id, name) VALUES ($1, 'Synthetic BA'), ($2, 'Synthetic BB')", [shopA, shopB]);
  await admin.query('INSERT INTO crm.user_membership (shop_id, user_id) VALUES ($1, $2), ($3, $4)', [shopA, userA, shopB, userB]);
  await admin.query(`INSERT INTO crm.customer (id, shop_id, name, created_source) VALUES ($1, $3, '합성 고객', 'manual'), ($2, $4, '합성 B', 'manual')`,
    [customerA, customerB, shopA, shopB]);
  await admin.query(`INSERT INTO crm.staff (id, shop_id, name, active, created_at) VALUES
    ($1, $5, 'SA', true, '2026-01-01T00:00:00Z'), ($2, $5, 'SB', true, '2026-01-02T00:00:00Z'),
    ($3, $5, 'S-off', false, '2026-01-03T00:00:00Z'), ($4, $6, 'S-other', true, '2026-01-01T00:00:00Z')`,
  [staffA, staffB, staffOff, staffOther, shopA, shopB]);
  // 월~토 09:00~22:00(서울), 일요일 휴무.
  const week = Object.fromEntries([1, 2, 3, 4, 5, 6].map((d) => [d, [{ open: '09:00', close: '22:00' }]]));
  for (const shop of [shopA, shopB]) await admin.query('UPDATE crm.shop_settings SET business_hours = $2 WHERE shop_id = $1', [shop, JSON.stringify(week)]);

  class TestModule {}
  Module({
    controllers: [AppointmentM1Controller, CalendarM1Controller, CalendarBlockController],
    providers: [DatabaseService, AppointmentM1Service, CalendarBlockService],
  })(TestModule);
  app = await NestFactory.create(TestModule, { logger: false });
  app.useGlobalFilters(new ApiExceptionFilter());
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
});

after(async () => {
  await app?.close();
  try {
    // 연결과 부모 차단은 한 트랜잭션에서 지운다 — 연결만 먼저 지우면 지연 제약(지정 차단 = 연결 1개 이상)이 커밋에서 막는다.
    await admin.query('BEGIN');
    for (const table of ['calendar_block_staff', 'calendar_block']) await admin.query(`DELETE FROM crm.${table} WHERE shop_id IN ($1, $2)`, [shopA, shopB]);
    await admin.query('COMMIT');
    for (const table of ['idempotency_key', 'appointment_m1', 'staff', 'customer', 'shop_closure', 'shop_settings', 'user_membership']) {
      await admin.query(`DELETE FROM crm.${table} WHERE shop_id IN ($1, $2)`, [shopA, shopB]);
    }
    await admin.query('DELETE FROM crm.shop WHERE id IN ($1, $2)', [shopA, shopB]);
  } finally {
    await admin.end();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

const cookieOf = (user, shop) => 'bv_session=' + signCookie(Buffer.from(SECRET, 'hex'), 'owner-session', `${user}:${shop}`, 600);
const ownerA = cookieOf(userA, shopA);
const ownerB = cookieOf(userB, shopB);
const A = `/api/shops/${shopA}`;

async function call(method, path, { cookie = ownerA, body, key = randomUUID() } = {}) {
  const headers = { Cookie: cookie };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (key && method !== 'GET') headers['Idempotency-Key'] = key;
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, replayed: res.headers.get('idempotent-replayed') };
}
// 서울 시각. 2027-02-01은 월요일.
const at = (day, hhmm) => `2027-02-${day}T${hhmm}:00+09:00`;
const block = (body, opts) => call('POST', `${A}/calendar-blocks`, { body: { allStaff: false, staffIds: [staffA], memo: null, ...body }, ...opts });
const removeBlock = (id, version, opts) => call('DELETE', `${A}/calendar-blocks/${id}?version=${version}`, opts);
const book = (overrides) => call('POST', `${A}/appointments`, { body: { customerId: customerA, staffId: staffA, startAt: at('01', '10:00'), durationMin: 60, ...overrides } });
const calendar = (from, to = from, cookie) => call('GET', `${A}/calendar?from=${from}&to=${to}`, { cookie });

test('등록 201: UTC 시각·전체는 빈 staffIds·메모 정리, 같은 키 재생, 입력 오류는 422', async () => {
  const key = randomUUID();
  const body = { startAt: at('01', '12:00'), endAt: at('01', '13:00'), allStaff: true, staffIds: [], memo: ' 점심 ' };
  const made = await call('POST', `${A}/calendar-blocks`, { body, key });
  assert.equal(made.status, 201);
  const { id, createdAt, updatedAt, ...rest } = made.body;
  assert.ok(id && createdAt && updatedAt);
  assert.deepEqual(rest, { startAt: '2027-02-01T03:00:00.000Z', endAt: '2027-02-01T04:00:00.000Z', allStaff: true, staffIds: [], memo: '점심', version: 1 });
  const again = await call('POST', `${A}/calendar-blocks`, { body, key });
  assert.deepEqual([again.status, again.replayed, again.body], [201, 'true', made.body]);

  const cases = [
    [{ startAt: at('01', '13:00'), endAt: at('01', '13:00') }, { field: 'endAt', code: 'INVALID_PERIOD' }],
    [{ startAt: at('01', '13:00'), endAt: at('01', '14:00'), allStaff: true, staffIds: [staffA] }, { field: 'staffIds', code: 'MUST_BE_EMPTY' }],
    [{ startAt: at('01', '13:00'), endAt: at('01', '14:00'), staffIds: [] }, { field: 'staffIds', code: 'REQUIRED' }],
    [{ startAt: at('01', '13:00'), endAt: at('01', '14:00'), staffIds: [staffA, staffA] }, { field: 'staffIds', code: 'DUPLICATE' }],
    [{ startAt: at('01', '13:00'), endAt: at('01', '14:00'), staffIds: [staffOther] }, { field: 'staffIds', code: 'NOT_FOUND' }],
    [{ startAt: at('01', '13:00'), endAt: at('01', '14:00'), staffIds: [staffOff] }, { field: 'staffIds', code: 'INACTIVE' }],
    [{ startAt: '2027-02-01T13:00:00', endAt: at('01', '14:00') }, { field: 'startAt', code: 'INVALID_DATETIME' }],
    [{ startAt: at('01', '13:00'), endAt: at('01', '14:00'), status: 'removed' }, { field: 'status', code: 'UNKNOWN_FIELD' }],
  ];
  for (const [over, expected] of cases) {
    const res = await block(over);
    assert.equal(res.status, 422, JSON.stringify(over));
    assert.equal(res.body.code, 'VALIDATION_FAILED');
    assert.deepEqual(res.body.details.fields[0], expected);
  }
  assert.equal((await call('POST', `/api/shops/${shopA}/calendar-blocks`, { cookie: ownerB, body })).status, 404, '다른 매장 원장');
});

test('담당자 A 차단: A 등록·이동은 409 BLOCKED, B는 허용, 준비만 겹쳐도 거부, 맞닿으면 허용, 메모만 고치면 재검사 없음', async () => {
  const b = await block({ startAt: at('02', '14:00'), endAt: at('02', '16:00') });
  assert.equal(b.status, 201);
  const clash = await book({ startAt: at('02', '15:00') });
  assert.deepEqual([clash.status, clash.body.code, clash.body.details], [409, 'BLOCKED', { conflictingIds: [b.body.id] }]);
  assert.equal((await book({ startAt: at('02', '15:00'), staffId: staffB })).status, 201, '다른 담당자는 허용');
  assert.equal((await book({ startAt: at('02', '16:10'), prepMin: 20 })).body.code, 'BLOCKED', '준비(15:50~)만 겹쳐도 거부');
  assert.equal((await book({ startAt: at('02', '16:00') })).status, 201, '차단 끝과 예약 점유 시작이 맞닿음');
  const early = await book({ startAt: at('02', '13:00') });
  assert.equal(early.status, 201, '예약 끝 14:00이 차단 시작과 맞닿음');

  const moved = await call('PATCH', `${A}/appointments/${early.body.id}`, { body: { version: 1, startAt: at('02', '13:30') } });
  assert.equal(moved.body.code, 'BLOCKED', '이동해서 겹치면 거부');
  const toA = await book({ startAt: at('02', '11:00'), staffId: staffB });
  assert.equal((await call('PATCH', `${A}/appointments/${toA.body.id}`, { body: { version: 1, staffId: staffA, startAt: at('02', '14:30') } })).body.code, 'BLOCKED');
  assert.equal((await call('PATCH', `${A}/appointments/${early.body.id}`, { body: { version: 1, memo: '메모만' } })).status, 200);
});

test('매장 전체 차단은 나중에 추가한 담당자에도 적용, 자정을 넘는 차단, 겹친 차단은 모두 반환', async () => {
  const all = await block({ startAt: at('03', '21:00'), endAt: at('04', '10:00'), allStaff: true, staffIds: [] });
  const late = randomUUID();
  await admin.query("INSERT INTO crm.staff (id, shop_id, name) VALUES ($1, $2, 'S-late')", [late, shopA]);
  assert.equal((await book({ startAt: at('03', '21:00'), staffId: late, durationMin: 30 })).body.code, 'BLOCKED');
  assert.equal((await book({ startAt: at('04', '09:00'), staffId: staffB })).body.code, 'BLOCKED', '자정 다음 날 아침');
  const second = await block({ startAt: at('04', '09:30'), endAt: at('04', '11:00') });
  const both = await book({ startAt: at('04', '09:00'), durationMin: 60 });
  assert.equal(both.body.code, 'BLOCKED');
  assert.deepEqual(both.body.details.conflictingIds, [all.body.id, second.body.id], '시작·id 순');
});

test('기존 예약은 그대로, blocks·blockedBy만 달라진다 → 제거하면 표시가 사라지고 다시 예약된다', async () => {
  const appt = await book({ startAt: at('05', '10:00') });
  const before = (await calendar('2027-02-05')).body.appointments.find((a) => a.id === appt.body.id);
  assert.deepEqual(before.blockedBy, []);
  const b = await block({ startAt: at('05', '10:30'), endAt: at('05', '12:00') });
  assert.equal(b.status, 201, '기존 예약과 겹쳐도 등록');
  const day = (await calendar('2027-02-05')).body;
  const after = day.appointments.find((a) => a.id === appt.body.id);
  assert.deepEqual(after.blockedBy, [b.body.id]);
  assert.equal(after.version, 1);
  assert.deepEqual({ ...after, blockedBy: [] }, before, '예약 내용·상태·버전 그대로');
  assert.deepEqual(day.blocks.map((x) => x.id), [b.body.id]);
  assert.deepEqual((await call('GET', `${A}/appointments/${appt.body.id}`)).body.blockedBy, [b.body.id], '상세도 같은 판정');

  assert.equal((await removeBlock(b.body.id, 1)).status, 204);
  const cleared = (await calendar('2027-02-05')).body;
  assert.deepEqual([cleared.blocks, cleared.appointments.find((a) => a.id === appt.body.id).blockedBy], [[], []]);
  assert.equal((await book({ startAt: at('05', '11:00') })).status, 201, '제거한 차단 때문에 거부되지 않는다');
});

test('취소 되살리기는 차단으로 거부하지 않고(Q2) blockedBy로 표시, 취소·무효는 blockedBy 빈 배열', async () => {
  const appt = await book({ startAt: at('06', '10:00') });
  assert.equal((await call('PUT', `${A}/appointments/${appt.body.id}/status`, { body: { version: 1, status: 'cancelled' } })).status, 200);
  const b = await block({ startAt: at('06', '10:00'), endAt: at('06', '11:00') });
  assert.deepEqual((await calendar('2027-02-06')).body.appointments.find((a) => a.id === appt.body.id).blockedBy, [], '취소는 점유가 아니다');
  const revived = await call('PUT', `${A}/appointments/${appt.body.id}/status`, { body: { version: 2, status: 'scheduled' } });
  assert.equal(revived.status, 200);
  assert.deepEqual(revived.body.blockedBy, [b.body.id]);
});

test('제거(D3): 같은 키·같은 버전 204 재생, 같은 키·다른 버전 422, 오래된 버전 409, 이미 제거 404, 버전 없음 422, 다른 매장 404', async () => {
  const b = await block({ startAt: at('08', '10:00'), endAt: at('08', '11:00') });
  const key = randomUUID();
  const first = await removeBlock(b.body.id, 1, { key });
  assert.equal(first.status, 204);
  const replay = await removeBlock(b.body.id, 1, { key });
  assert.deepEqual([replay.status, replay.replayed], [204, 'true']);
  assert.equal((await removeBlock(b.body.id, 2, { key })).body.code, 'IDEMPOTENCY_KEY_REUSED');
  const stale = await removeBlock(b.body.id, 1);
  assert.deepEqual([stale.status, stale.body.code, stale.body.details], [409, 'VERSION_CONFLICT', { currentVersion: 2 }]);
  const gone = await removeBlock(b.body.id, 2);
  assert.deepEqual([gone.status, gone.body.code], [404, 'NOT_FOUND']);
  assert.equal((await call('DELETE', `${A}/calendar-blocks/${b.body.id}`)).body.details.fields[0].code, 'REQUIRED');
  assert.equal((await removeBlock(randomUUID(), 1)).status, 404);
  const other = await block({ startAt: at('08', '12:00'), endAt: at('08', '13:00') });
  assert.equal((await call('DELETE', `/api/shops/${shopB}/calendar-blocks/${other.body.id}?version=1`, { cookie: ownerB })).status, 404);
  const { rows: [row] } = await admin.query('SELECT status, version FROM crm.calendar_block WHERE id = $1', [b.body.id]);
  assert.deepEqual(row, { status: 'removed', version: 2 });
  const { rows: links } = await admin.query('SELECT staff_id FROM crm.calendar_block_staff WHERE block_id = $1', [b.body.id]);
  assert.deepEqual(links, [{ staff_id: staffA }], '제거해도 대상 연결은 보존');
});

test('조회: 기간과 겹치는 활성 차단만 시작·id 순, 숨긴 담당자가 걸린 차단은 그 담당자도 보낸다(D6), 다른 매장 격리', async () => {
  const hidden = randomUUID();
  await admin.query("INSERT INTO crm.staff (id, shop_id, name, created_at) VALUES ($1, $2, 'S-hide', '2026-01-04T00:00:00Z')", [hidden, shopA]);
  const late = await block({ startAt: at('09', '15:00'), endAt: at('09', '16:00') });
  const early = await block({ startAt: at('08', '23:00'), endAt: at('09', '01:00'), staffIds: [hidden] });
  const removed = await block({ startAt: at('09', '12:00'), endAt: at('09', '13:00') });
  await removeBlock(removed.body.id, 1);
  await admin.query('UPDATE crm.staff SET active = false WHERE id = $1', [hidden]);
  await call('POST', `/api/shops/${shopB}/calendar-blocks`, { cookie: ownerB, body: { startAt: at('09', '10:00'), endAt: at('09', '11:00'), allStaff: true, staffIds: [] } });

  const day = (await calendar('2027-02-09')).body;
  assert.deepEqual(day.blocks.map((b) => b.id), [early.body.id, late.body.id], '전날 23시에 시작해 걸친 차단 포함, 제거·다른 매장 제외');
  assert.deepEqual(day.blocks[0].staffIds, [hidden]);
  assert.ok(day.staff.some((s) => s.id === hidden && s.active === false), '숨긴 담당자 이름을 보낸다');
  assert.ok(!(await calendar('2027-02-10')).body.staff.some((s) => s.id === hidden), '그 차단이 없는 날엔 안 보낸다');
});

test('RLS: 앱 역할은 다른 매장 차단을 보지 못하고, 부모 차단을 물리 삭제할 수 없다', async () => {
  const b = await block({ startAt: at('10', '10:00'), endAt: at('10', '11:00') });
  const appRole = new Client({ connectionString: process.env.DATABASE_URL });
  await appRole.connect();
  try {
    await appRole.query('BEGIN');
    await appRole.query("SELECT set_config('app.shop_id', $1, true)", [shopB]);
    assert.equal((await appRole.query('SELECT 1 FROM crm.calendar_block WHERE id = $1', [b.body.id])).rowCount, 0);
    assert.equal((await appRole.query('SELECT 1 FROM crm.calendar_block_staff WHERE block_id = $1', [b.body.id])).rowCount, 0);
    await appRole.query('ROLLBACK');
    await appRole.query('BEGIN');
    await appRole.query("SELECT set_config('app.shop_id', $1, true)", [shopA]);
    await assert.rejects(appRole.query('DELETE FROM crm.calendar_block WHERE id = $1', [b.body.id]), /permission denied/);
    await appRole.query('ROLLBACK');
  } finally {
    await appRole.end();
  }
});

test('지연 제약: 지정 차단에 담당자가 없거나 전체 차단에 담당자가 있으면 커밋 실패, 제거된 차단은 다시 못 바꾼다', async () => {
  const orphan = randomUUID();
  await admin.query('BEGIN');
  await admin.query(`INSERT INTO crm.calendar_block (id, shop_id, start_at, end_at, all_staff) VALUES ($1, $2, $3, $4, false)`,
    [orphan, shopA, at('11', '10:00'), at('11', '11:00')]);
  await assert.rejects(admin.query('COMMIT'), (e) => e.constraint === 'calendar_block_targets');
  const everyone = randomUUID();
  await admin.query('BEGIN');
  await admin.query(`INSERT INTO crm.calendar_block (id, shop_id, start_at, end_at, all_staff) VALUES ($1, $2, $3, $4, true)`,
    [everyone, shopA, at('11', '10:00'), at('11', '11:00')]);
  await admin.query('INSERT INTO crm.calendar_block_staff (shop_id, block_id, staff_id) VALUES ($1, $2, $3)', [shopA, everyone, staffA]);
  await assert.rejects(admin.query('COMMIT'), (e) => e.constraint === 'calendar_block_targets');
  await assert.rejects(admin.query(`INSERT INTO crm.calendar_block_staff (shop_id, block_id, staff_id)
    SELECT $1, id, $2 FROM crm.calendar_block WHERE shop_id = $3 LIMIT 1`, [shopA, staffOther, shopA]), (e) => e.code === '23503', '다른 매장 담당자 연결은 FK로 거부');

  const b = await block({ startAt: at('11', '12:00'), endAt: at('11', '13:00') });
  await removeBlock(b.body.id, 1);
  await assert.rejects(admin.query("UPDATE crm.calendar_block SET status = 'active' WHERE id = $1", [b.body.id]), (e) => e.constraint === 'calendar_block_removed_final');
});

// ── 두 연결의 커밋 순서(Q3). 다른 연결이 같은 매장 쓰기 잠금을 쥔 채 쓰고, API 요청이 잠금에서 기다린 뒤 결과를 본다. ──
const LOCK = "SELECT pg_advisory_xact_lock(hashtextextended('crm.shop-write:' || $1::uuid::text, 0))";

async function holdLock(shop, write) {
  const race = new Client({ connectionString: process.env.DATABASE_MIGRATION_URL });
  await race.connect();
  await race.query('BEGIN');
  const { rows: [{ pid }] } = await race.query('SELECT pg_backend_pid() AS pid');
  await race.query(LOCK, [shop]);
  if (write) await write(race);
  return { race, pid };
}

async function waitForLockWait(blockerPid) {
  for (let i = 0; i < 100; i++) {
    const { rows: [{ waiting }] } = await admin.query(
      `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'
         AND $1::int = ANY(pg_blocking_pids(pid))) AS waiting`, [blockerPid]);
    if (waiting) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('API 요청이 매장 쓰기 잠금에서 기다리지 않았다');
}

test('차단이 먼저 커밋되면 기다리던 예약은 그 차단을 보고 409 BLOCKED', async () => {
  const held = randomUUID();
  const { race, pid } = await holdLock(shopA, async (c) => {
    await c.query(`INSERT INTO crm.calendar_block (id, shop_id, start_at, end_at, all_staff) VALUES ($1, $2, $3, $4, true)`,
      [held, shopA, at('12', '10:00'), at('12', '12:00')]);
  });
  try {
    const pending = book({ startAt: at('12', '11:00') });
    await waitForLockWait(pid);
    await race.query('COMMIT');
    const res = await pending;
    assert.deepEqual([res.status, res.body.code, res.body.details], [409, 'BLOCKED', { conflictingIds: [held] }]);
  } finally {
    await race.query('ROLLBACK').catch(() => {});
    await race.end();
  }
});

test('예약이 먼저 커밋되면 기다리던 차단도 저장되고 예약에 겹침이 표시된다', async () => {
  const held = randomUUID();
  const { race, pid } = await holdLock(shopA, async (c) => {
    await c.query(`INSERT INTO crm.appointment_m1 (id, shop_id, customer_id, staff_id, start_at, duration_min) VALUES ($1, $2, $3, $4, $5, 60)`,
      [held, shopA, customerA, staffA, at('13', '10:00')]);
  });
  try {
    const pending = block({ startAt: at('13', '10:30'), endAt: at('13', '11:30') });
    await waitForLockWait(pid);
    await race.query('COMMIT');
    const res = await pending;
    assert.equal(res.status, 201);
    assert.deepEqual((await calendar('2027-02-13')).body.appointments.find((a) => a.id === held).blockedBy, [res.body.id]);
  } finally {
    await race.query('ROLLBACK').catch(() => {});
    await race.end();
  }
});

test('다른 매장의 쓰기 잠금은 기다리지 않는다', async () => {
  const { race } = await holdLock(shopA);
  try {
    const res = await Promise.race([
      call('POST', `/api/shops/${shopB}/calendar-blocks`, { cookie: ownerB, body: { startAt: at('15', '10:00'), endAt: at('15', '11:00'), allStaff: true, staffIds: [] } }),
      new Promise((r) => setTimeout(() => r({ status: 'timeout' }), 3000)),
    ]);
    assert.equal(res.status, 201);
  } finally {
    await race.query('ROLLBACK');
    await race.end();
  }
});
