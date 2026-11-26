// BEA-175 캘린더 조회·BEA-176 취소(·178 상태) API — 실제 PostgreSQL + Nest 앱으로 계약 #42 calendar·/status를 확인한다.
// 수용 기준(설계 04 보강): 기간 1·42·43일과 역순·없는 날짜 / 매장 자정 UTC 변환과 점유 교차(경계 닿기만 하면 제외) /
// 관리 시작·id 정렬 / 취소·무효 포함 / 메뉴 없음 / 활성 + 참조된 비활성 담당자 / 매장 격리 /
// 취소 후 같은 시간 새 예약 / 되살릴 때 겹치면 거부, 안 겹치면 영업시간·휴무와 무관 / 재생·오래된 version·같은 상태·voided.
// 합성 데이터만 쓴다(절대 규칙 8).
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
const { signCookie } = require('../dist/owner-session.js');

const SECRET = 'cd'.repeat(32);
const env = {
  KAKAO_CLIENT_ID: 'test-app', KAKAO_CLIENT_SECRET: 'test-secret',
  KAKAO_REDIRECT_URI: 'https://example.test/api/auth/kakao/callback', BV_SESSION_SECRET: SECRET,
};
const savedEnv = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
const admin = new Client({ connectionString: process.env.DATABASE_MIGRATION_URL });
const [shopA, shopB, userA, userB, customerA, customerB, staff1, staff2, staffOff, staffOffUnused, staffB, menuA] =
  Array.from({ length: 12 }, () => randomUUID());
let app;
let base;

before(async () => {
  Object.assign(process.env, env);
  await admin.connect();
  await admin.query("INSERT INTO crm.shop (id, name) VALUES ($1, 'Synthetic CA'), ($2, 'Synthetic CB')", [shopA, shopB]);
  await admin.query('INSERT INTO crm.user_membership (shop_id, user_id) VALUES ($1, $2), ($3, $4)', [shopA, userA, shopB, userB]);
  await admin.query(`INSERT INTO crm.customer (id, shop_id, name, created_source) VALUES
    ($1, $3, '합성 고객', 'manual'), ($2, $4, '합성 B', 'manual')`, [customerA, customerB, shopA, shopB]);
  // 생성 순서를 고정하려고 created_at을 직접 넣는다(담당자 정렬 = 생성 시각·id).
  await admin.query(`INSERT INTO crm.staff (id, shop_id, name, active, created_at) VALUES
    ($1, $6, 'S1', true, '2026-01-01T00:00:00Z'), ($2, $6, 'S2', true, '2026-01-02T00:00:00Z'),
    ($3, $6, 'S-off', false, '2026-01-03T00:00:00Z'), ($4, $6, 'S-off-unused', false, '2026-01-04T00:00:00Z'),
    ($5, $7, 'SB', true, '2026-01-01T00:00:00Z')`,
  [staff1, staff2, staffOff, staffOffUnused, staffB, shopA, shopB]);
  await admin.query("INSERT INTO crm.menu (id, shop_id, name) VALUES ($1, $2, '합성 관리')", [menuA, shopA]);
  // 월~토 10:00~20:00(서울), 일요일은 키 없음 = 휴무.
  const week = Object.fromEntries([1, 2, 3, 4, 5, 6].map((d) => [d, [{ open: '10:00', close: '20:00' }]]));
  await admin.query('UPDATE crm.shop_settings SET business_hours = $2 WHERE shop_id = $1', [shopA, JSON.stringify(week)]);

  class TestModule {}
  Module({ controllers: [AppointmentM1Controller, CalendarM1Controller], providers: [DatabaseService, AppointmentM1Service] })(TestModule);
  app = await NestFactory.create(TestModule, { logger: false });
  app.useGlobalFilters(new ApiExceptionFilter());
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
});

after(async () => {
  await app?.close();
  try {
    for (const table of ['idempotency_key', 'appointment_m1', 'staff', 'menu', 'customer', 'shop_closure', 'shop_settings', 'user_membership']) {
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
const calendar = (from, to, cookie) => call('GET', `${A}/calendar?from=${from}&to=${to}`, { cookie });
const setStatus = (id, body, opts = {}) => call('PUT', `${A}/appointments/${id}/status`, { body, ...opts });

/** 영업시간 검사를 거치지 않고 행을 직접 넣는다(자정 근처·휴무일 예약 — 설정을 바꾸기 전 예약과 같은 상태). */
async function insert({ shop = shopA, customer = customerA, staff = staff1, start, duration = 60, cleanup = 0, status = 'scheduled', menu = null }) {
  const { rows: [{ id }] } = await admin.query(`INSERT INTO crm.appointment_m1
    (shop_id, customer_id, staff_id, menu_id, start_at, duration_min, cleanup_min, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
  [shop, customer, staff, menu, start, duration, cleanup, status]);
  return id;
}

test('기간: 1일·42일은 200, 43일·역순·없는 날짜·빠짐·다른 모양은 400 INVALID_RANGE', async () => {
  assert.equal((await calendar('2027-01-04', '2027-01-04')).status, 200);
  assert.equal((await calendar('2027-01-01', '2027-02-11')).status, 200, '양 끝 포함 42일');
  for (const [from, to] of [['2027-01-01', '2027-02-12'], ['2027-01-05', '2027-01-04'], ['2027-02-29', '2027-03-01'], ['2027-1-4', '2027-01-05']]) {
    const res = await calendar(from, to);
    assert.equal(res.status, 400, `${from}~${to}`);
    assert.equal(res.body.code, 'INVALID_RANGE');
  }
  assert.equal((await call('GET', `${A}/calendar?from=2027-01-04`)).body.code, 'INVALID_RANGE');
});

test('점유 교차: 매장 자정(UTC−9h) 경계 — 걸치면 포함, 닿기만 하면 제외, 정리만 걸쳐도 포함', async () => {
  // 2027-01-11(월) 서울 = [2027-01-10T15:00Z, 2027-01-11T15:00Z)
  const endsAtMidnight = await insert({ start: '2027-01-10T14:00:00Z' }); // 서울 1/10 23:00~1/11 00:00 — 닿기만
  const crossesIn = await insert({ start: '2027-01-10T14:30:00Z', staff: staff2 }); // 1/10 23:30~1/11 00:30
  const cleanupInto = await insert({ start: '2027-01-10T13:50:00Z', cleanup: 30 }); // 1/10 22:50~23:50 시술, 정리 ~1/11 00:20
  const startsAtNextMidnight = await insert({ start: '2027-01-11T15:00:00Z', staff: staff2 }); // 1/12 00:00 — 닿기만
  const day = await calendar('2027-01-11', '2027-01-11');
  assert.equal(day.status, 200);
  const ids = day.body.appointments.map((a) => a.id);
  assert.ok(!ids.includes(endsAtMidnight), '전날 자정에 끝나는 예약은 빠진다');
  assert.ok(!ids.includes(startsAtNextMidnight), '다음 날 자정에 시작하는 예약은 빠진다');
  assert.deepEqual(ids, [cleanupInto, crossesIn], '정리만 걸친 예약 + 걸친 예약(시작 순)');
  assert.deepEqual(day.body.blocks, []);
});

test('정렬·취소/무효 포함·메뉴 없음·담당자(활성 + 참조된 비활성)·매장 격리', async () => {
  // 2027-01-18(월)
  const sameStartA = await insert({ start: '2027-01-18T01:00:00Z', staff: staff1, menu: menuA });
  const sameStartB = await insert({ start: '2027-01-18T01:00:00Z', staff: staff2 });
  const cancelled = await insert({ start: '2027-01-18T00:00:00Z', status: 'cancelled' });
  const voided = await insert({ start: '2027-01-18T03:00:00Z', status: 'voided' });
  const byHidden = await insert({ start: '2027-01-18T05:00:00Z', staff: staffOff });
  await insert({ shop: shopB, customer: customerB, staff: staffB, start: '2027-01-18T01:00:00Z' });

  const res = await calendar('2027-01-18', '2027-01-18');
  assert.equal(res.status, 200);
  const tie = [sameStartA, sameStartB].sort();
  assert.deepEqual(res.body.appointments.map((a) => a.id), [cancelled, ...tie, voided, byHidden], '관리 시작, 같으면 id 순');
  assert.deepEqual(res.body.appointments.map((a) => a.status), ['cancelled', 'scheduled', 'scheduled', 'voided', 'scheduled']);
  const withMenu = res.body.appointments.find((a) => a.id === sameStartA);
  assert.deepEqual([withMenu.customerName, withMenu.menuName, withMenu.blockedBy], ['합성 고객', '합성 관리', []]);
  assert.equal(res.body.appointments.find((a) => a.id === sameStartB).menuName, null);
  assert.deepEqual(res.body.staff.map((s) => [s.name, s.active]), [['S1', true], ['S2', true], ['S-off', false]],
    '참조 안 된 비활성 담당자는 빠진다, 생성 순');
  assert.ok(res.body.staff.every((s) => s.version >= 1 && s.createdAt && s.updatedAt));

  const other = await calendar('2027-01-18', '2027-01-18', ownerB);
  assert.equal(other.status, 404, '다른 매장 원장은 경로부터 404');
  const own = await call('GET', `/api/shops/${shopB}/calendar?from=2027-01-18&to=2027-01-18`, { cookie: ownerB });
  assert.deepEqual(own.body.staff.map((s) => s.name), ['SB']);
  assert.equal(own.body.appointments.length, 1);
});

test('취소 200 → 같은 시간 새 예약 가능 → 되살리면 409 STAFF_OVERLAP, 새 예약을 치우면 되살림 200', async () => {
  const made = await call('POST', `${A}/appointments`, { body: { customerId: customerA, staffId: staff1, startAt: '2027-01-19T11:00:00+09:00', durationMin: 60 } });
  assert.equal(made.status, 201);
  const cancelled = await setStatus(made.body.id, { version: 1, status: 'cancelled' });
  assert.equal(cancelled.status, 200);
  assert.deepEqual([cancelled.body.status, cancelled.body.version], ['cancelled', 2]);

  const again = await call('POST', `${A}/appointments`, { body: { customerId: customerA, staffId: staff1, startAt: '2027-01-19T11:30:00+09:00', durationMin: 30 } });
  assert.equal(again.status, 201, '취소된 예약은 점유하지 않는다');
  const revive = await setStatus(made.body.id, { version: 2, status: 'scheduled' });
  assert.equal(revive.status, 409);
  assert.deepEqual(revive.body, { code: 'STAFF_OVERLAP', message: '같은 담당자의 다른 예약과 시간이 겹칩니다.', details: { conflictingIds: [again.body.id] } });

  assert.equal((await setStatus(again.body.id, { version: 1, status: 'cancelled' })).status, 200);
  const revived = await setStatus(made.body.id, { version: 2, status: 'completed' });
  assert.equal(revived.status, 200, '취소 → 완료도 점유를 되살린다(겹침 없음)');
  assert.deepEqual([revived.body.status, revived.body.version], ['completed', 3]);
});

test('되살리기는 영업시간·휴무로 거부하지 않는다(Q2) — 일요일 취소 예약', async () => {
  const sunday = await insert({ start: '2027-01-24T02:00:00Z', status: 'cancelled' }); // 1/24(일) 11:00 서울
  const res = await setStatus(sunday, { version: 1, status: 'scheduled' });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'scheduled');
});

test('상태 오류: 오래된 version 409, 같은 상태 409 NO_CHANGE, voided 행 409 INVALID_TRANSITION, voided·모르는 칸 422, 404', async () => {
  const id = await insert({ start: '2027-01-20T01:00:00Z' });
  const stale = await setStatus(id, { version: 9, status: 'cancelled' });
  assert.equal(stale.status, 409);
  assert.deepEqual([stale.body.code, stale.body.details], ['VERSION_CONFLICT', { currentVersion: 1 }]);
  const same = await setStatus(id, { version: 1, status: 'scheduled' });
  assert.deepEqual([same.status, same.body.code], [409, 'NO_CHANGE']);
  const toVoid = await setStatus(id, { version: 1, status: 'voided' });
  assert.equal(toVoid.status, 422);
  assert.deepEqual(toVoid.body.details.fields, [{ field: 'status', code: 'INVALID_STATUS' }]);
  const extra = await setStatus(id, { status: 'cancelled', memo: 'x' });
  assert.deepEqual(extra.body.details.fields, [{ field: 'memo', code: 'UNKNOWN_FIELD' }, { field: 'version', code: 'REQUIRED' }]);

  const voided = await insert({ start: '2027-01-20T03:00:00Z', status: 'voided' });
  const fromVoid = await setStatus(voided, { version: 1, status: 'scheduled' });
  assert.deepEqual([fromVoid.status, fromVoid.body.code], [409, 'INVALID_TRANSITION']);

  assert.equal((await setStatus(randomUUID(), { version: 1, status: 'cancelled' })).status, 404);
  assert.equal((await setStatus('not-a-uuid', { version: 1, status: 'cancelled' })).status, 404);
  assert.equal((await setStatus(id, { version: 1, status: 'cancelled' }, { cookie: ownerB })).status, 404);
  const { rows: [row] } = await admin.query('SELECT status, version FROM crm.appointment_m1 WHERE id = $1', [id]);
  assert.deepEqual(row, { status: 'scheduled', version: 1 }, '거부된 요청은 아무것도 바꾸지 않는다');
});

test('같은 키·같은 요청은 재생, 같은 키·다른 상태는 422 IDEMPOTENCY_KEY_REUSED, 키 없음 400', async () => {
  const id = await insert({ start: '2027-01-21T01:00:00Z' });
  const key = randomUUID();
  const first = await setStatus(id, { version: 1, status: 'no_show' }, { key });
  const again = await setStatus(id, { version: 1, status: 'no_show' }, { key });
  assert.equal(again.status, 200);
  assert.equal(again.replayed, 'true');
  assert.deepEqual(again.body, first.body);
  assert.equal((await setStatus(id, { version: 1, status: 'completed' }, { key })).body.code, 'IDEMPOTENCY_KEY_REUSED');
  assert.equal((await setStatus(id, { version: 2, status: 'completed' }, { key: null })).body.code, 'INVALID_IDEMPOTENCY_KEY');
});
