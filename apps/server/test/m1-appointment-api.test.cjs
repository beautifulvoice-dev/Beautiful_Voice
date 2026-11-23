// BEA-176 예약 등록·상세·변경 API — 실제 PostgreSQL + Nest 앱으로 계약 #42의 appointments 동작을 확인한다.
// 수용 기준(설계 04): 같은 담당자 겹침 거부·다른 담당자 허용 / 영업시간·휴무(관리 구간만) / 매장 간 참조 거부 /
// 중복 전송 / 동시 저장(DB 제약이 최종 판정) / 오래된 version / 변경 때 D2 재검사 범위. 합성 데이터만 쓴다(절대 규칙 8).
require('reflect-metadata');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { test, before, after } = require('node:test');
const { Module } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const { Client } = require('pg');
const { DatabaseService } = require('../dist/database.service.js');
const { ApiExceptionFilter } = require('../dist/common/api-exception.filter.js');
const { AppointmentM1Controller } = require('../dist/appointments-m1/appointment-m1.controller.js');
const { AppointmentM1Service } = require('../dist/appointments-m1/appointment-m1.service.js');
const { signCookie } = require('../dist/owner-session.js');

const SECRET = 'ef'.repeat(32);
const env = {
  KAKAO_CLIENT_ID: 'test-app', KAKAO_CLIENT_SECRET: 'test-secret',
  KAKAO_REDIRECT_URI: 'https://example.test/api/auth/kakao/callback', BV_SESSION_SECRET: SECRET,
};
const savedEnv = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
const admin = new Client({ connectionString: process.env.DATABASE_MIGRATION_URL });
const [shopA, shopB, userA, userB, customerA, customerOff, customerB, staff1, staff2, staffOff, staffB, menuA, menuB] =
  Array.from({ length: 13 }, () => randomUUID());
let app;
let base;

before(async () => {
  Object.assign(process.env, env);
  await admin.connect();
  await admin.query("INSERT INTO crm.shop (id, name) VALUES ($1, 'Synthetic A'), ($2, 'Synthetic B')", [shopA, shopB]);
  await admin.query('INSERT INTO crm.user_membership (shop_id, user_id) VALUES ($1, $2), ($3, $4)', [shopA, userA, shopB, userB]);
  await admin.query(`INSERT INTO crm.customer (id, shop_id, name, created_source, active, deactivated_at) VALUES
    ($1, $4, '합성 고객', 'manual', true, NULL), ($2, $4, '합성 휴면', 'manual', false, now()), ($3, $5, '합성 B', 'manual', true, NULL)`,
  [customerA, customerOff, customerB, shopA, shopB]);
  await admin.query(`INSERT INTO crm.staff (id, shop_id, name, active) VALUES
    ($1, $5, 'S1', true), ($2, $5, 'S2', true), ($3, $5, 'S-off', false), ($4, $6, 'SB', true)`,
  [staff1, staff2, staffOff, staffB, shopA, shopB]);
  await admin.query("INSERT INTO crm.menu (id, shop_id, name) VALUES ($1, $3, '합성 관리'), ($2, $4, 'B 관리')", [menuA, menuB, shopA, shopB]);
  // 월~토 10:00~20:00(서울), 일요일은 키 없음 = 휴무. 12/25(금)는 공휴일 휴무.
  // 토요일만 휴게 없이 맞닿은 구간 + 실제 휴게(15:00~16:00) — 설정 API가 이렇게 저장한다(#55 리뷰).
  const week = Object.fromEntries([1, 2, 3, 4, 5].map((d) => [d, [{ open: '10:00', close: '20:00' }]]));
  week[6] = [{ open: '10:00', close: '13:00' }, { open: '13:00', close: '15:00' }, { open: '16:00', close: '20:00' }];
  await admin.query('UPDATE crm.shop_settings SET business_hours = $2 WHERE shop_id = $1', [shopA, JSON.stringify(week)]);
  await admin.query("INSERT INTO crm.shop_closure (shop_id, kind, start_date, end_date) VALUES ($1, 'holiday', '2026-12-25', '2026-12-25')", [shopA]);

  class TestModule {}
  Module({ controllers: [AppointmentM1Controller], providers: [DatabaseService, AppointmentM1Service] })(TestModule);
  app = await NestFactory.create(TestModule, { logger: false });
  app.useGlobalFilters(new ApiExceptionFilter());
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
});

after(async () => {
  await app?.close();
  try {
    for (const table of ['idempotency_key', 'appointment_m1_event', 'appointment_m1', 'staff', 'menu', 'customer', 'shop_closure', 'shop_settings', 'user_membership']) {
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
const A = `/api/shops/${shopA}/appointments`;

async function call(method, path, { cookie = ownerA, body, key = randomUUID() } = {}) {
  const headers = { Cookie: cookie };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (key && method !== 'GET') headers['Idempotency-Key'] = key;
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, replayed: res.headers.get('idempotent-replayed') };
}
// 서울 시각으로 적는다. 2026-12-01은 화요일.
const at = (day, hhmm) => `2026-12-${day}T${hhmm}:00+09:00`;
const book = (overrides) => call('POST', A, { body: { customerId: customerA, staffId: staff1, startAt: at('01', '10:00'), durationMin: 60, ...overrides } });
const patch = (id, body, opts = {}) => call('PATCH', `${A}/${id}`, { body, ...opts });

test('등록 201 → 상세 조회가 같은 값(UTC 저장, 준비 기본 0, 차단 빈 배열)', async () => {
  const created = await book({ startAt: at('02', '10:00'), menuId: menuA, memo: ' 첫 방문 ' });
  assert.equal(created.status, 201);
  const { id, version, createdAt, updatedAt, ...rest } = created.body;
  assert.equal(version, 1);
  assert.ok(id && createdAt && updatedAt);
  assert.deepEqual(rest, {
    customerId: customerA, menuId: menuA, staffId: staff1, startAt: '2026-12-02T01:00:00.000Z', durationMin: 60, prepMin: 0,
    memo: '첫 방문', status: 'scheduled', customerName: '합성 고객', menuName: '합성 관리', blockedBy: [],
  });
  assert.deepEqual((await call('GET', `${A}/${id}`)).body, created.body);
  // 다른 매장 원장은 경로부터 404, 자기 매장 경로로 남의 예약 id를 물어도 404
  assert.equal((await call('GET', `${A}/${id}`, { cookie: ownerB })).status, 404);
  const foreign = await call('GET', `/api/shops/${shopB}/appointments/${id}`, { cookie: ownerB });
  assert.equal(foreign.status, 404);
  assert.equal(foreign.body.code, 'NOT_FOUND');
  assert.equal((await call('GET', `${A}/not-a-uuid`)).status, 404);
});

test('M1 API 등록·수정·상태 변경은 원자적으로 이력이 남고 앱은 직접 추가할 수 없다', async () => {
  const created = await book({ startAt: at('09', '10:00'), memo: '이전 메모' });
  assert.equal(created.status, 201);
  const { id } = created.body;
  const updated = await patch(id, { version: 1, memo: '수정한 메모' });
  assert.equal(updated.status, 200);
  const cancelled = await call('PUT', `${A}/${id}/status`, { body: { version: 2, status: 'cancelled' } });
  assert.equal(cancelled.status, 200);

  const appDb = new DatabaseService();
  try {
    await appDb.withShop(shopA, async (client) => {
      const { rows } = await client.query(
        `SELECT version, event_type, before_change->>'memo' AS old_memo, after_change->>'status' AS status
         FROM crm.appointment_m1_event WHERE appointment_id = $1 ORDER BY version`, [id],
      );
      assert.deepEqual(rows, [
        { version: 1, event_type: 'created', old_memo: null, status: 'scheduled' },
        { version: 2, event_type: 'updated', old_memo: '이전 메모', status: 'scheduled' },
        { version: 3, event_type: 'status_changed', old_memo: '수정한 메모', status: 'cancelled' },
      ]);
    });
    await appDb.withShop(shopB, async (client) => {
      assert.equal((await client.query('SELECT 1 FROM crm.appointment_m1_event WHERE appointment_id = $1', [id])).rowCount, 0);
    });
    await assert.rejects(appDb.withShop(shopA, (client) =>
      client.query('INSERT INTO crm.appointment_m1_event DEFAULT VALUES')), { code: '42501' });
  } finally {
    await appDb.onModuleDestroy();
  }
});

test('같은 담당자 점유 겹침은 409(준비 시간 포함), 다른 담당자는 같은 시각 허용, 맞붙은 시각은 허용', async () => {
  const first = await book({ startAt: at('03', '11:00') });
  assert.equal(first.status, 201);
  const clash = await book({ startAt: at('03', '12:30'), prepMin: 40 }); // 점유 11:50~ → 11:00~12:00과 겹침
  assert.equal(clash.status, 409);
  assert.deepEqual(clash.body.details, { conflictingIds: [first.body.id] });
  assert.equal(clash.body.code, 'STAFF_OVERLAP');
  assert.equal((await book({ startAt: at('03', '11:00'), staffId: staff2 })).status, 201);
  assert.equal((await book({ startAt: at('03', '12:30'), prepMin: 30 })).status, 201, '점유 12:00~ — 끝과 시작이 맞닿으면 겹침 아님');
});

test('영업시간·휴무는 관리 구간만 본다 — 준비만 영업 전에 걸치면 허용', async () => {
  const late = await book({ startAt: at('04', '19:30') });
  assert.equal(late.status, 422);
  assert.equal(late.body.code, 'OUTSIDE_BUSINESS_HOURS');
  assert.equal((await book({ startAt: at('04', '09:30') })).body.code, 'OUTSIDE_BUSINESS_HOURS');
  assert.equal((await book({ startAt: at('06', '12:00') })).body.code, 'CLOSED_DAY', '일요일(영업시간 없음)');
  assert.equal((await book({ startAt: at('25', '12:00') })).body.code, 'CLOSED_DAY', '공휴일 휴무');
  const prepBeforeOpen = await book({ startAt: at('04', '10:00'), prepMin: 30 });
  assert.equal(prepBeforeOpen.status, 201);
  assert.equal((await book({ startAt: at('04', '19:00'), staffId: staff2 })).status, 201, '마감 시각에 딱 끝나면 허용');
});

test('맞닿은 영업 구간에 걸친 관리는 201, 실제 휴게 공백에 걸치면 422(#55 리뷰)', async () => {
  assert.equal((await book({ startAt: at('12', '12:30') })).status, 201, '13:00에 맞닿은 두 구간은 이어진 영업시간');
  const gap = await book({ startAt: at('12', '14:30'), staffId: staff2 });
  assert.equal(gap.status, 422);
  assert.equal(gap.body.code, 'OUTSIDE_BUSINESS_HOURS');
});

test('다른 매장·비활성 참조와 형식 오류는 422 VALIDATION_FAILED(ASSUMPTION D3)', async () => {
  const foreign = await book({ customerId: customerB, staffId: staffB, menuId: menuB, startAt: at('05', '10:00') });
  assert.equal(foreign.status, 422);
  assert.deepEqual(foreign.body.details.fields, [
    { field: 'customerId', code: 'NOT_FOUND' }, { field: 'staffId', code: 'NOT_FOUND' }, { field: 'menuId', code: 'NOT_FOUND' }]);
  const inactive = await book({ customerId: customerOff, staffId: staffOff, startAt: at('05', '10:00') });
  assert.deepEqual(inactive.body.details.fields, [{ field: 'customerId', code: 'INACTIVE' }, { field: 'staffId', code: 'INACTIVE' }]);
  const bad = await call('POST', A, { body: { customerId: 'x', startAt: '2026-12-05T10:00:00', durationMin: 0, prepMin: -1, status: 'completed' } });
  assert.equal(bad.status, 422);
  assert.deepEqual(bad.body.details.fields, [
    { field: 'status', code: 'UNKNOWN_FIELD' }, { field: 'customerId', code: 'INVALID_ID' }, { field: 'staffId', code: 'REQUIRED' },
    { field: 'startAt', code: 'INVALID_DATETIME' }, { field: 'durationMin', code: 'INVALID_MINUTES' }, { field: 'prepMin', code: 'INVALID_MINUTES' }]);
  assert.equal((await book({ startAt: '2026-02-30T10:00:00+09:00' })).body.details.fields[0].code, 'INVALID_DATETIME');
  const { rows: [{ count }] } = await admin.query("SELECT count(*)::int FROM crm.appointment_m1 WHERE shop_id = $1 AND start_at::date = '2026-12-05'", [shopA]);
  assert.equal(count, 0);
});

test('같은 키·같은 요청은 같은 응답 재생, 같은 키·다른 요청은 422', async () => {
  const key = randomUUID();
  const body = { customerId: customerA, staffId: staff1, startAt: at('07', '10:00'), durationMin: 30 };
  const first = await call('POST', A, { body, key });
  const again = await call('POST', A, { body, key });
  assert.equal(again.status, 201);
  assert.equal(again.replayed, 'true');
  assert.deepEqual(again.body, first.body);
  const reused = await call('POST', A, { body: { ...body, durationMin: 45 }, key });
  assert.equal(reused.status, 422);
  assert.equal(reused.body.code, 'IDEMPOTENCY_KEY_REUSED');
  const { rows } = await admin.query("SELECT id FROM crm.appointment_m1 WHERE shop_id = $1 AND start_at = '2026-12-07T01:00:00Z'", [shopA]);
  assert.equal(rows.length, 1);
  assert.equal((await call('POST', A, { body, key: null })).body.code, 'INVALID_IDEMPOTENCY_KEY');
});

test('동시 저장: 앱 검사를 통과해도 DB 제약이 409 STAFF_OVERLAP — 키도 롤백돼 같은 키로 다시 판정', async () => {
  const held = randomUUID();
  const race = new Client({ connectionString: process.env.DATABASE_MIGRATION_URL });
  await race.connect();
  try {
    // 커밋 전 행은 API 트랜잭션에 보이지 않는다 → 앱 검사는 통과하고 INSERT가 제약 대기 → 커밋 뒤 23P01.
    await race.query('BEGIN');
    const { rows: [{ pid: blockerPid }] } = await race.query('SELECT pg_backend_pid() AS pid');
    await race.query(`INSERT INTO crm.appointment_m1 (id, shop_id, customer_id, staff_id, start_at, duration_min)
      VALUES ($1, $2, $3, $4, '2026-12-08T01:00:00Z', 60)`, [held, shopA, customerA, staff1]);
    const key = randomUUID();
    const body = { customerId: customerA, staffId: staff1, startAt: at('08', '10:30'), durationMin: 60 };
    const pending = call('POST', A, { body, key });
    await waitForLockWait(blockerPid);
    await race.query('COMMIT');
    const res = await pending;
    assert.equal(res.status, 409);
    assert.deepEqual(res.body, { code: 'STAFF_OVERLAP', message: '같은 담당자의 다른 예약과 시간이 겹칩니다.', details: { conflictingIds: [held] } });
    const { rows } = await admin.query('SELECT 1 FROM crm.idempotency_key WHERE shop_id = $1 AND key = $2', [shopA, key]);
    assert.equal(rows.length, 0, '409는 저장하지 않는다');
    const retry = await call('POST', A, { body, key });
    assert.equal(retry.status, 409);
    assert.equal(retry.replayed, null);
  } finally {
    await race.query('ROLLBACK').catch(() => {});
    await race.end();
  }

  const results = await Promise.all(Array.from({ length: 8 }, (_, i) =>
    book({ startAt: at('09', '10:00'), durationMin: 60 + i })));
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409, 409, 409, 409, 409, 409, 409]);
  assert.ok(results.every((r) => r.status === 201 || r.body.code === 'STAFF_OVERLAP'));
});

async function waitForLockWait(blockerPid) {
  for (let i = 0; i < 100; i++) {
    const { rows: [{ waiting }] } = await admin.query(
      `SELECT EXISTS (
         SELECT 1 FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'
            AND $1::int = ANY(pg_blocking_pids(pid))
       ) AS waiting`,
      [blockerPid]);
    if (waiting) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('API 요청이 DB 제약 대기에 들어가지 않았다');
}

test('변경: 자기 자신과는 겹치지 않고 조금 옮길 수 있다, 오래된 version은 409, 보낸 필드만 바뀐다', async () => {
  const made = await book({ startAt: at('10', '10:00'), menuId: menuA, memo: '그대로' });
  const moved = await patch(made.body.id, { version: 1, startAt: at('10', '10:15') });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.version, 2);
  assert.equal(moved.body.startAt, '2026-12-10T01:15:00.000Z');
  assert.equal(moved.body.memo, '그대로');
  assert.equal(moved.body.menuId, menuA);
  const stale = await patch(made.body.id, { version: 1, memo: '늦은 수정' });
  assert.equal(stale.status, 409);
  assert.deepEqual(stale.body.details, { currentVersion: 2 });
  assert.equal((await patch(made.body.id, { memo: 'x' })).body.details.fields[0].code, 'REQUIRED');
  assert.equal((await patch(made.body.id, { version: 2, status: 'cancelled' })).body.details.fields[0].code, 'UNKNOWN_FIELD');
  const cleared = await patch(made.body.id, { version: 2, menuId: null, memo: null });
  assert.deepEqual([cleared.body.menuId, cleared.body.menuName, cleared.body.memo, cleared.body.version], [null, null, null, 3]);
  assert.equal((await patch(randomUUID(), { version: 1, memo: 'x' })).status, 404);
  assert.equal((await patch(made.body.id, { version: 3, memo: 'x' }, { cookie: ownerB })).status, 404);
});

test('변경 재검사 범위(D2): 메모만은 검사 없음, 준비만은 겹침만, 길이가 마감을 넘으면 영업시간 거부', async () => {
  // 영업시간을 줄이기 전에 만들어진 예약 — 일요일 행을 직접 넣는다(파생 S2: 기존 예약은 그대로 남는다).
  const { rows: [{ id: sunday }] } = await admin.query(`INSERT INTO crm.appointment_m1 (shop_id, customer_id, staff_id, start_at, duration_min)
    VALUES ($1, $2, $3, '2026-12-13T01:00:00Z', 60) RETURNING id`, [shopA, customerOff, staffOff]);
  assert.equal((await patch(sunday, { version: 1, memo: '메모만' })).status, 200, '비활성 고객·담당자의 기존 예약도 메모는 고친다');
  assert.equal((await patch(sunday, { version: 2, prepMin: 15 })).status, 200, '준비만 바꾸면 영업시간을 보지 않는다');
  assert.equal((await patch(sunday, { version: 3, durationMin: 90 })).body.code, 'CLOSED_DAY', '종료가 바뀌면 재검사');
  assert.deepEqual((await patch(sunday, { version: 3, staffId: staffOff, customerId: customerOff, memo: '같은 값' })).status, 200,
    '같은 참조를 다시 보내는 것은 바꾸는 것이 아니다');

  const a = await book({ startAt: at('11', '10:00') });
  const b = await book({ startAt: at('11', '11:00') });
  const prepClash = await patch(b.body.id, { version: 1, prepMin: 30 });
  assert.equal(prepClash.status, 409);
  assert.deepEqual(prepClash.body.details, { conflictingIds: [a.body.id] });
  assert.equal((await patch(b.body.id, { version: 1, durationMin: 600 })).body.code, 'OUTSIDE_BUSINESS_HOURS');
  assert.equal((await patch(b.body.id, { version: 1, staffId: staffOff })).body.details.fields[0].code, 'INACTIVE');
  assert.equal((await patch(b.body.id, { version: 1, customerId: customerB })).body.details.fields[0].code, 'NOT_FOUND');
  const toOther = await patch(b.body.id, { version: 1, staffId: staff2, startAt: at('11', '10:00') });
  assert.equal(toOther.status, 200, '다른 담당자로 옮기면 같은 시각도 허용');
  assert.equal((await patch(b.body.id, { version: 2, staffId: staff1 })).body.code, 'STAFF_OVERLAP');
});
