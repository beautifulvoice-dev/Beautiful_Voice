// S4 지갑 ② API(설계 13 §3·§4·§5, wallet.openapi.yaml) — 실제 PostgreSQL + Nest 앱. 합성 데이터만(절대 규칙 8).
// 매장은 세션으로만 정한다(ADR-0009 A단계): 세션 없음 401, 다른 매장 고객은 404/422, 재전송은 처음 응답 재생.
require('reflect-metadata');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { test, before, after } = require('node:test');
const { Module } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const { Client } = require('pg');
const { DatabaseService } = require('../dist/database.service.js');
const { ApiExceptionFilter } = require('../dist/common/api-exception.filter.js');
const { encodeCursor } = require('../dist/common/pagination.js');
const { WalletController } = require('../dist/wallet/wallet.controller.js');
const { WalletService } = require('../dist/wallet/wallet.service.js');
const { signCookie } = require('../dist/owner-session.js');

const SECRET = 'cd'.repeat(32);
const env = {
  KAKAO_CLIENT_ID: 'test-app', KAKAO_CLIENT_SECRET: 'test-secret',
  KAKAO_REDIRECT_URI: 'https://example.test/api/auth/kakao/callback', BV_SESSION_SECRET: SECRET,
  BV_OWNER_CONSENT_VERSION: undefined, BV_OWNER_CONSENT_TEXT: undefined,
};
const savedEnv = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
const admin = new Client({ connectionString: process.env.DATABASE_MIGRATION_URL });
const [shopA, shopB, userA, userB, customerA, customerA2, customerB, menuA, menuB] = Array.from({ length: 9 }, () => randomUUID());
const cookieOf = (user, shop) => 'bv_session=' + signCookie(Buffer.from(SECRET, 'hex'), 'owner-session', `${user}:${shop}`, 600);
const ownerA = cookieOf(userA, shopA);
const ownerB = cookieOf(userB, shopB);
let app;
let base;

before(async () => {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await admin.connect();
  await admin.query("INSERT INTO crm.shop (id, name) VALUES ($1, 'Synthetic XA'), ($2, 'Synthetic XB')", [shopA, shopB]);
  await admin.query('INSERT INTO crm.user_membership (shop_id, user_id) VALUES ($1, $2), ($3, $4)', [shopA, userA, shopB, userB]);
  await admin.query(`INSERT INTO crm.customer (id, shop_id, name, created_source) VALUES
    ($1, $4, '합성 고객', 'manual'), ($2, $4, '합성 고객 둘', 'manual'), ($3, $5, '합성 B', 'manual')`, [customerA, customerA2, customerB, shopA, shopB]);
  await admin.query("INSERT INTO crm.menu (id, shop_id, name) VALUES ($1, $3, '합성 윤곽관리'), ($2, $4, '합성 B 메뉴')", [menuA, menuB, shopA, shopB]);
  class TestModule {}
  Module({ controllers: [WalletController], providers: [DatabaseService, WalletService] })(TestModule);
  app = await NestFactory.create(TestModule, { logger: false });
  app.useGlobalFilters(new ApiExceptionFilter());
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
});

after(async () => {
  await app?.close();
  try {
    for (const table of ['idempotency_key', 'wallet_entry', 'customer_pass', 'menu', 'customer', 'shop_settings', 'user_membership']) {
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

async function call(method, path, { cookie = ownerA, body, key = randomUUID() } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (key && method !== 'GET') headers['Idempotency-Key'] = key;
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, replayed: res.headers.get('idempotent-replayed') };
}
const issue = (body, opts) => call('POST', '/api/passes', { body: { customerId: customerA, name: '합성 10회권', menuId: menuA, sessions: 10, ...body }, ...opts });
const record = (body, opts) => call('POST', '/api/wallet-entries', { body: { customerId: customerA, unitType: 'amount', label: 'payment', value: 1000, ...body }, ...opts });
const summary = (customerId, opts) => call('GET', `/api/wallets/${customerId}`, opts);
const entries = (query, opts) => call('GET', `/api/wallet-entries?${new URLSearchParams(query)}`, opts);
const fieldCodes = (res) => res.body.details.fields.map((f) => `${f.field}:${f.code}`).sort();

test('세션이 없거나 위조면 모든 지갑 주소가 401', async () => {
  for (const cookie of [null, ownerA.slice(0, -2) + 'xx']) {
    for (const res of [
      await summary(customerA, { cookie }), await entries({ customerId: customerA, unitType: 'amount' }, { cookie }),
      await issue({}, { cookie }), await record({}, { cookie }),
    ]) {
      assert.equal(res.status, 401);
      assert.equal(res.body.code, 'UNAUTHENTICATED');
    }
  }
});

test('발급 → 요약 → 결제·차감 → 음수 허용, 응답에 적용 직후 값, 선불금은 발급과 무관', async () => {
  const empty = await summary(customerA2);
  assert.deepEqual([empty.status, empty.body], [200, { customerId: customerA2, prepaidBalance: 0, passes: [] }]);

  const pass = await issue({ customerId: customerA2, isPrimary: true });
  assert.equal(pass.status, 201);
  assert.deepEqual(Object.keys(pass.body).sort(),
    ['customerId', 'id', 'isPrimary', 'menuId', 'menuName', 'name', 'remainingSessions', 'version'].sort());
  assert.deepEqual([pass.body.remainingSessions, pass.body.menuName, pass.body.isPrimary], [10, '합성 윤곽관리', true]);
  const next = await issue({ customerId: customerA2, name: '합성 5회권', sessions: 5, isPrimary: true });

  const paid = await record({ customerId: customerA2, value: 30000 });
  assert.equal(paid.status, 201);
  assert.deepEqual([paid.body.signedDelta, paid.body.prepaidBalance, paid.body.remainingSessions], [30000, 30000, null]);
  const over = await record({ customerId: customerA2, label: 'deduct', value: 50000 });
  assert.deepEqual([over.body.signedDelta, over.body.prepaidBalance], [-50000, -20000]);
  for (let i = 0; i < 11; i += 1) await record({ customerId: customerA2, unitType: 'sessions', passId: pass.body.id, label: 'deduct', value: 1 });
  const last = await record({ customerId: customerA2, unitType: 'sessions', passId: pass.body.id, label: 'deduct', value: 1 });
  assert.deepEqual([last.body.signedDelta, last.body.remainingSessions, last.body.prepaidBalance], [-1, -2, null]);

  const after = await summary(customerA2);
  assert.equal(after.body.prepaidBalance, -20000);
  assert.deepEqual(after.body.passes.map((p) => [p.id, p.remainingSessions, p.isPrimary]),
    [[next.body.id, 5, true], [pass.body.id, -2, false]], '대표 먼저, 새 대표를 고르면 기존 대표는 내려간다');
});

test('거래 목록: 항목별·최신순·커서로 이어 읽고, 삭제 표시 행은 빠진다', async () => {
  const pass = await issue({});
  const made = [];
  for (let i = 1; i <= 5; i += 1) made.push((await record({ unitType: 'sessions', passId: pass.body.id, label: 'deduct', value: i })).body.id);
  await record({ value: 777 });
  await admin.query('UPDATE crm.wallet_entry SET deleted_at = now() WHERE id = $1', [made[2]]);

  const first = await entries({ customerId: customerA, unitType: 'sessions', passId: pass.body.id, limit: '3' });
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.items.map((e) => e.id), [made[4], made[3], made[1]]);
  assert.ok(first.body.nextCursor);
  const second = await entries({ customerId: customerA, unitType: 'sessions', passId: pass.body.id, limit: '3', cursor: first.body.nextCursor });
  assert.deepEqual(second.body.items.map((e) => [e.label, e.signedDelta]), [['deduct', -1], ['payment', 10]]);
  assert.equal(second.body.nextCursor, null);
  assert.deepEqual(Object.keys(second.body.items[0]).sort(), ['appointmentId', 'createdAt', 'customerId', 'cycleSeq', 'id', 'label', 'memo',
    'passId', 'signedDelta', 'unitType', 'updatedAt', 'version'].sort());

  const prepaid = await entries({ customerId: customerA, unitType: 'amount' });
  assert.ok(prepaid.body.items.every((e) => e.unitType === 'amount' && e.passId === null));
  assert.ok(prepaid.body.items.some((e) => e.signedDelta === 777));

  assert.deepEqual((await entries({ customerId: customerA, unitType: 'amount', cursor: 'not*valid' })).body.code, 'INVALID_CURSOR');
  assert.equal((await entries({ customerId: customerA, unitType: 'amount', limit: '0' })).body.code, 'INVALID_LIMIT');
  assert.deepEqual(fieldCodes(await entries({ customerId: customerA, unitType: 'sessions' })), ['passId:REQUIRED']);
  assert.deepEqual(fieldCodes(await entries({ customerId: customerA, unitType: 'amount', passId: pass.body.id })), ['passId:MUST_BE_EMPTY']);
  assert.deepEqual(fieldCodes(await entries({ unitType: 'coins', shopId: shopB })), ['customerId:REQUIRED', 'shopId:UNKNOWN_FIELD', 'unitType:INVALID_VALUE']);
  assert.equal((await entries({ customerId: customerA2, unitType: 'sessions', passId: pass.body.id })).status, 404, '다른 고객의 횟수권');
});

test('거래 커서의 시각은 실제 UTC 날짜와 마이크로초 형식이어야 한다', async () => {
  const query = { customerId: customerA, unitType: 'amount' };
  const id = randomUUID();
  for (const v of ['0', '2026-02-29T12:00:00.123456Z', '0000-01-01T12:00:00.123456Z',
    '2026-11-27T24:00:00.000000Z', '2026-11-27T12:00:00.123Z', '2026-11-27T12:00:00.123456Z\n']) {
    const res = await entries({ ...query, cursor: encodeCursor({ v, id }) });
    assert.deepEqual([res.status, res.body.code], [400, 'INVALID_CURSOR'], JSON.stringify(v));
  }
  const leapDay = await entries({ ...query, cursor: encodeCursor({ v: '2024-02-29T12:00:00.123456Z', id }) });
  assert.equal(leapDay.status, 200);
});

test('입력 오류는 422 — 0·소수·signedDelta·예약·opening_balance·없는 횟수권·메뉴·고객', async () => {
  const cases = [
    [await record({ value: 0 }), ['value:INVALID_VALUE']],
    [await record({ value: 1.5 }), ['value:INVALID_VALUE']],
    [await record({ signedDelta: -1000 }), ['signedDelta:UNKNOWN_FIELD']],
    [await record({ appointmentId: randomUUID(), cycleSeq: 1 }), ['appointmentId:UNKNOWN_FIELD', 'cycleSeq:UNKNOWN_FIELD']],
    [await record({ label: 'opening_balance' }), ['label:INVALID_VALUE']],
    [await record({ shopId: shopB }), ['shopId:UNKNOWN_FIELD']],
    [await record({ unitType: 'sessions', passId: randomUUID(), label: 'deduct' }), ['passId:NOT_FOUND']],
    [await record({ customerId: customerB }), ['customerId:NOT_FOUND']],
    [await issue({ menuId: menuB }), ['menuId:NOT_FOUND']],
    [await issue({ sessions: 0, name: ' ' }), ['name:REQUIRED', 'sessions:INVALID_VALUE']],
  ];
  for (const [res, codes] of cases) {
    assert.equal(res.status, 422);
    assert.equal(res.body.code, 'VALIDATION_FAILED');
    assert.deepEqual(fieldCodes(res), codes);
  }
});

test('다른 매장: 경로의 고객은 404, 본문의 고객은 422, 목록·요약에 다른 매장 행이 보이지 않는다', async () => {
  const pass = await issue({});
  assert.equal((await summary(customerA, { cookie: ownerB })).status, 404);
  assert.equal((await summary('not-a-uuid')).status, 404);
  assert.equal((await entries({ customerId: customerA, unitType: 'amount' }, { cookie: ownerB })).status, 404);
  const cross = await record({ unitType: 'sessions', passId: pass.body.id, label: 'deduct' }, { cookie: ownerB });
  assert.deepEqual([cross.status, fieldCodes(cross)], [422, ['customerId:NOT_FOUND']]);
  assert.deepEqual(fieldCodes(await issue({}, { cookie: ownerB })), ['customerId:NOT_FOUND']);
  assert.deepEqual((await summary(customerB, { cookie: ownerB })).body, { customerId: customerB, prepaidBalance: 0, passes: [] });
});

test('멱등: 키 없으면 400, 같은 키·같은 요청은 처음 응답을 재생(한 번만 기록), 같은 키·다른 요청은 422', async () => {
  assert.equal((await record({}, { key: null })).body.code, 'INVALID_IDEMPOTENCY_KEY');
  assert.equal((await issue({}, { key: null })).body.code, 'INVALID_IDEMPOTENCY_KEY');

  const customer = randomUUID();
  await admin.query("INSERT INTO crm.customer (id, shop_id, name, created_source) VALUES ($1, $2, '합성 멱등', 'manual')", [customer, shopA]);
  const key = randomUUID();
  const firstPay = await record({ customerId: customer, value: 5000 }, { key });
  const againPay = await record({ customerId: customer, value: 5000 }, { key });
  assert.deepEqual([againPay.status, againPay.replayed, againPay.body], [201, 'true', firstPay.body]);
  assert.equal((await record({ customerId: customer, value: 6000 }, { key })).body.code, 'IDEMPOTENCY_KEY_REUSED');

  const passKey = randomUUID();
  const firstPass = await issue({ customerId: customer }, { key: passKey });
  const againPass = await issue({ customerId: customer }, { key: passKey });
  assert.deepEqual([againPass.replayed, againPass.body], ['true', firstPass.body]);
  const after = await summary(customer);
  assert.deepEqual([after.body.prepaidBalance, after.body.passes.length, after.body.passes[0].remainingSessions], [5000, 1, 10]);
});
