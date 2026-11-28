// BEA-166 설정 API — 실제 PostgreSQL + Nest 앱으로 계약 #42의 영업시간·매장 안내 정보·휴무를 확인한다.
// 수용 기준: 다섯 가지를 저장하고 다시 열면 그대로 보인다 / 요일 휴무와 날짜 구간 휴가 모두.
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
const { SettingsController } = require('../dist/settings/settings.controller.js');
const { SettingsService } = require('../dist/settings/settings.service.js');
const { signCookie } = require('../dist/owner-session.js');

const SECRET = 'cd'.repeat(32);
const env = {
  KAKAO_CLIENT_ID: 'test-app', KAKAO_CLIENT_SECRET: 'test-secret',
  KAKAO_REDIRECT_URI: 'https://example.test/api/auth/kakao/callback', BV_SESSION_SECRET: SECRET,
};
const savedEnv = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
const admin = new Client({ connectionString: process.env.DATABASE_MIGRATION_URL });
const [shopA, shopB, userA, userB] = Array.from({ length: 4 }, () => randomUUID());
let app;
let base;

before(async () => {
  Object.assign(process.env, env);
  await admin.connect();
  // 매장을 만들면 트리거가 shop_settings 행을 만든다(#43 010).
  await admin.query("INSERT INTO crm.shop (id, name) VALUES ($1, 'Synthetic A'), ($2, 'Synthetic B')", [shopA, shopB]);
  await admin.query('INSERT INTO crm.user_membership (shop_id, user_id) VALUES ($1, $2), ($3, $4)', [shopA, userA, shopB, userB]);
  class TestModule {}
  Module({ controllers: [SettingsController], providers: [DatabaseService, SettingsService] })(TestModule);
  app = await NestFactory.create(TestModule, { logger: false });
  app.useGlobalFilters(new ApiExceptionFilter());
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
});

after(async () => {
  await app?.close();
  try {
    for (const table of ['idempotency_key', 'shop_closure', 'shop_settings', 'user_membership']) {
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

async function call(method, path, { cookie = ownerA, body, key = randomUUID() } = {}) {
  const headers = { Cookie: cookie };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (key && method !== 'GET') headers['Idempotency-Key'] = key;
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, replayed: res.headers.get('idempotent-replayed') };
}
const A = `/api/shops/${shopA}`;

test('로그인 없으면 401, 다른 매장 경로는 404(존재 여부를 숨김)', async () => {
  assert.equal((await call('GET', `${A}/settings/business-hours`, { cookie: '' })).status, 401);
  const other = await call('GET', `${A}/settings/business-hours`, { cookie: ownerB });
  assert.equal(other.status, 404);
  assert.equal(other.body.code, 'SHOP_NOT_FOUND');
  const write = await call('PUT', `${A}/settings/shop-info`, { cookie: ownerB, body: { refundPolicy: 'x' } });
  assert.equal(write.status, 404);
});

test('영업시간: 처음엔 null(미입력), 저장하면 다시 읽어도 그대로, 잘못된 값은 422', async () => {
  assert.deepEqual((await call('GET', `${A}/settings/business-hours`)).body, { businessHours: null });
  const hours = { 1: [{ open: '14:00', close: '19:00' }, { open: '10:00', close: '13:00' }], 6: [{ open: '10:00', close: '24:00' }] };
  const saved = await call('PUT', `${A}/settings/business-hours`, { body: { businessHours: hours } });
  assert.equal(saved.status, 200);
  const sorted = { 1: [{ open: '10:00', close: '13:00' }, { open: '14:00', close: '19:00' }], 6: [{ open: '10:00', close: '24:00' }] };
  assert.deepEqual(saved.body, { businessHours: sorted });
  assert.deepEqual((await call('GET', `${A}/settings/business-hours`)).body, { businessHours: sorted });

  const bad = await call('PUT', `${A}/settings/business-hours`, { body: { businessHours: { 2: [{ open: '18:00', close: '10:00' }] } } });
  assert.equal(bad.status, 422);
  assert.deepEqual(bad.body.details, { reason: 'OPEN_NOT_BEFORE_CLOSE', at: '2[0]' });
  assert.deepEqual((await call('GET', `${A}/settings/business-hours`)).body, { businessHours: sorted }, '실패한 저장은 아무것도 바꾸지 않는다');

  const { rows: [before] } = await admin.query('SELECT updated_at FROM crm.shop_settings WHERE shop_id = $1', [shopA]);
  assert.deepEqual((await call('PUT', `${A}/settings/business-hours`, { body: { businessHours: null } })).body, { businessHours: null });
  const { rows: [after] } = await admin.query('SELECT updated_at FROM crm.shop_settings WHERE shop_id = $1', [shopA]);
  assert.ok(after.updated_at > before.updated_at, '영업시간 저장도 updated_at을 갱신한다(shop_settings에는 트리거 없음)');
  // 다른 매장 설정은 그대로
  assert.deepEqual((await call('GET', `/api/shops/${shopB}/settings/business-hours`, { cookie: ownerB })).body, { businessHours: null });
});

test('쓰기는 Idempotency-Key 필수 — 없거나 잘못되면 400', async () => {
  const none = await call('PUT', `${A}/settings/business-hours`, { body: { businessHours: null }, key: null });
  assert.equal(none.status, 400);
  assert.equal(none.body.code, 'INVALID_IDEMPOTENCY_KEY');
  assert.equal((await call('PUT', `${A}/settings/business-hours`, { body: { businessHours: null }, key: 'has space' })).status, 400);
});

test('매장 안내 정보: 5칸 저장 → 다시 읽어도 그대로, javascript: 링크는 422', async () => {
  const empty = { refundPolicy: null, naverPlaceUrl: null, instagramUrl: null, landingUrl: null, locationText: null };
  assert.deepEqual((await call('GET', `${A}/settings/shop-info`)).body, empty);
  const info = {
    refundPolicy: '하루 전까지 전액 환불\n당일 취소는 50%', naverPlaceUrl: 'https://example.com/place/1',
    instagramUrl: 'https://example.com/ig', landingUrl: null, locationText: '합성시 합성로 1, 2층',
  };
  const saved = await call('PUT', `${A}/settings/shop-info`, { body: { ...info, landingUrl: '  ' } });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body, info);
  assert.deepEqual((await call('GET', `${A}/settings/shop-info`)).body, info);

  const bad = await call('PUT', `${A}/settings/shop-info`, { body: { ...info, landingUrl: 'javascript:alert(1)' } });
  assert.equal(bad.status, 422);
  assert.deepEqual(bad.body, { code: 'VALIDATION_FAILED', message: '입력값을 확인해 주세요.', details: { fields: [{ field: 'landingUrl', code: 'INVALID_URL' }] } });
  assert.deepEqual((await call('GET', `${A}/settings/shop-info`)).body, info);
});

test('휴무: 요일 휴무와 날짜 구간 휴가 추가·목록·삭제', async () => {
  const weekly = await call('POST', `${A}/closures`, { body: { kind: 'weekly', weekday: 7, note: ' 정기 휴무 ' } });
  assert.equal(weekly.status, 201);
  assert.deepEqual({ ...weekly.body, id: undefined }, { id: undefined, kind: 'weekly', weekday: 7, note: '정기 휴무' });
  const vacation = await call('POST', `${A}/closures`, { body: { kind: 'vacation', startDate: '2026-12-30', endDate: '2027-01-02' } });
  assert.equal(vacation.status, 201);
  assert.deepEqual({ ...vacation.body, id: undefined }, { id: undefined, kind: 'vacation', startDate: '2026-12-30', endDate: '2027-01-02', note: null });

  const listed = await call('GET', `${A}/closures`);
  assert.deepEqual(listed.body.items.map((c) => c.id), [weekly.body.id, vacation.body.id], '요일 휴무 먼저');

  const bad = await call('POST', `${A}/closures`, { body: { kind: 'holiday', startDate: '2026-12-05', endDate: '2026-12-01' } });
  assert.equal(bad.status, 422);
  assert.deepEqual(bad.body.details, { reason: 'START_AFTER_END' });

  // 다른 매장 원장은 자기 매장 경로로도 A의 휴무를 지울 수 없다(RLS + shop_id 조건)
  assert.equal((await call('DELETE', `/api/shops/${shopB}/closures/${weekly.body.id}`, { cookie: ownerB })).status, 404);
  assert.equal((await call('DELETE', `${A}/closures/not-a-uuid`)).status, 404);
  const removed = await call('DELETE', `${A}/closures/${weekly.body.id}`);
  assert.equal(removed.status, 204);
  assert.equal((await call('DELETE', `${A}/closures/${weekly.body.id}`)).status, 404, '새 키로 다시 지우면 이미 없음');
  assert.deepEqual((await call('GET', `${A}/closures`)).body.items.map((c) => c.id), [vacation.body.id]);
});

test('같은 키로 재전송하면 한 번만 저장되고 처음 응답을 돌려준다, 같은 키·다른 본문은 422', async () => {
  const key = randomUUID();
  const body = { kind: 'holiday', startDate: '2026-12-25', endDate: '2026-12-25' };
  const first = await call('POST', `${A}/closures`, { body, key });
  const again = await call('POST', `${A}/closures`, { body, key });
  assert.equal(first.status, 201);
  assert.equal(again.status, 201);
  assert.equal(first.replayed, null);
  assert.equal(again.replayed, 'true');
  assert.deepEqual(again.body, first.body);
  const holidays = (await call('GET', `${A}/closures`)).body.items.filter((c) => c.startDate === '2026-12-25');
  assert.equal(holidays.length, 1);

  const reused = await call('POST', `${A}/closures`, { body: { ...body, endDate: '2026-12-26' }, key });
  assert.equal(reused.status, 422);
  assert.equal(reused.body.code, 'IDEMPOTENCY_KEY_REUSED');

  // 실패한 요청은 키를 남기지 않는다 → 고쳐서 같은 키로 다시 보낼 수 있다
  const retryKey = randomUUID();
  assert.equal((await call('POST', `${A}/closures`, { body: { kind: 'weekly', weekday: 9 }, key: retryKey })).status, 422);
  assert.equal((await call('POST', `${A}/closures`, { body: { kind: 'weekly', weekday: 1 }, key: retryKey })).status, 201);
});

test('같은 키라도 쿼리(예: 삭제의 version)가 다르면 다른 요청 — 이전 응답을 재생하지 않고 422', async () => {
  const closure = (await call('POST', `${A}/closures`, { body: { kind: 'weekly', weekday: 3 } })).body;
  const key = randomUUID();
  // 휴무 삭제는 쿼리를 쓰지 않지만, 차단 삭제(BEA-179)의 ?version=처럼 쿼리가 요청의 일부인 경우를 같은 경로로 확인한다.
  const first = await call('DELETE', `${A}/closures/${closure.id}?version=1&x=a`, { key });
  assert.equal(first.status, 204);
  const reordered = await call('DELETE', `${A}/closures/${closure.id}?x=a&version=1`, { key });
  assert.equal(reordered.status, 204, '쿼리 순서만 다르면 같은 요청');
  assert.equal(reordered.replayed, 'true');
  const changed = await call('DELETE', `${A}/closures/${closure.id}?version=2&x=a`, { key });
  assert.equal(changed.status, 422);
  assert.equal(changed.body.code, 'IDEMPOTENCY_KEY_REUSED');
});

test('예약 규칙(S3): 담당자 필수는 처음 꺼짐, 저장하면 그대로 읽힌다, 잘못된 값·모르는 칸은 422, 다른 매장은 404', async () => {
  const rules = `${A}/settings/appointment-rules`;
  assert.deepEqual((await call('GET', rules)).body, { requireStaffSelection: false });
  const on = await call('PUT', rules, { body: { requireStaffSelection: true } });
  assert.deepEqual([on.status, on.body], [200, { requireStaffSelection: true }]);
  assert.deepEqual((await call('GET', rules)).body, { requireStaffSelection: true });
  const bad = await call('PUT', rules, { body: { requireStaffSelection: 'yes', version: 1 } });
  assert.deepEqual([bad.status, bad.body.details.fields], [422, [
    { field: 'version', code: 'UNKNOWN_FIELD' }, { field: 'requireStaffSelection', code: 'INVALID_BOOLEAN' }]]);
  assert.equal((await call('PUT', rules, { body: {} })).body.details.fields[0].code, 'REQUIRED');
  assert.equal((await call('GET', rules, { cookie: ownerB })).status, 404);
  assert.equal((await call('PUT', rules, { body: { requireStaffSelection: false }, key: null })).status, 400, 'Idempotency-Key 필수');
  assert.equal((await call('PUT', rules, { body: { requireStaffSelection: false } })).body.requireStaffSelection, false);
});
