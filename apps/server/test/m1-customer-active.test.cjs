// BEA-173 고객 비활성화·재활성화 — 실제 PostgreSQL + Nest 앱으로 계약 #42의 PUT customers/{id}/active를 확인한다.
// 수용 기준: 비활성화해도 예약 기록이 보인다 / 예약이 자동 취소되지 않는다(AC-CRM-4) / 재활성화가 된다.
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
const { CustomerController } = require('../dist/customers/customer.controller.js');
const { CustomerService } = require('../dist/customers/customer.service.js');
const { signCookie } = require('../dist/owner-session.js');

const SECRET = 'd0'.repeat(32);
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
  Module({ controllers: [CustomerController], providers: [DatabaseService, CustomerService] })(TestModule);
  app = await NestFactory.create(TestModule, { logger: false });
  app.useGlobalFilters(new ApiExceptionFilter());
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
});

after(async () => {
  await app?.close();
  try {
    for (const table of ['idempotency_key', 'appointment_m1', 'staff', 'customer', 'shop_settings', 'user_membership']) {
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

const C = `${A}/customers`;

test('비활성화해도 예약은 예정 그대로, 고객 조회·예약 기록은 남고, 재활성화가 된다', async () => {
  const customer = (await call('POST', C, { body: { name: '비활성 합성', phone: '01000000077' } })).body;
  const staffId = randomUUID();
  await admin.query("INSERT INTO crm.staff (id, shop_id, name) VALUES ($1, $2, '원장')", [staffId, shopA]);
  const { rows: [appointment] } = await admin.query(
    `INSERT INTO crm.appointment_m1 (shop_id, customer_id, staff_id, start_at, duration_min)
     VALUES ($1, $2, $3, '2026-12-10T14:00:00+09:00', 60) RETURNING id`, [shopA, customer.id, staffId]);

  const off = await call('PUT', `${C}/${customer.id}/active`, { body: { version: 1, active: false } });
  assert.equal(off.status, 200);
  assert.equal(off.body.active, false);
  assert.match(off.body.deactivatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(off.body.version, 2);

  const { rows: [kept] } = await admin.query('SELECT status, customer_id FROM crm.appointment_m1 WHERE id = $1', [appointment.id]);
  assert.deepEqual(kept, { status: 'scheduled', customer_id: customer.id }, '예약은 자동 취소되지 않는다(AC-CRM-4)');
  assert.equal((await call('GET', `${C}/${customer.id}`)).body.active, false, '비활성 고객도 읽힌다(R30)');
  assert.ok(!(await call('GET', `${C}?limit=100`)).body.items.some((c) => c.id === customer.id), '기본 목록에서는 빠진다');
  assert.ok((await call('GET', `${C}?limit=100&includeInactive=true`)).body.items.some((c) => c.id === customer.id));

  const on = await call('PUT', `${C}/${customer.id}/active`, { body: { version: 2, active: true } });
  assert.equal(on.status, 200);
  assert.deepEqual([on.body.active, on.body.deactivatedAt, on.body.version], [true, null, 3]);
  assert.ok((await call('GET', `${C}?limit=100`)).body.items.some((c) => c.id === customer.id));
});

test('이미 그 상태면 409 NO_CHANGE, 옛 version은 409 VERSION_CONFLICT, 잘못된 본문은 422', async () => {
  const customer = (await call('POST', C, { body: { name: '상태 합성' } })).body;
  const same = await call('PUT', `${C}/${customer.id}/active`, { body: { version: 1, active: true } });
  assert.equal(same.status, 409);
  assert.equal(same.body.code, 'NO_CHANGE');
  assert.equal((await call('PUT', `${C}/${customer.id}/active`, { body: { version: 1, active: false } })).status, 200);
  const stale = await call('PUT', `${C}/${customer.id}/active`, { body: { version: 1, active: true } });
  assert.equal(stale.status, 409);
  assert.deepEqual([stale.body.code, stale.body.details], ['VERSION_CONFLICT', { currentVersion: 2 }]);
  assert.equal((await call('PUT', `${C}/${customer.id}/active`, { body: { version: 2, active: 'yes' } })).status, 422);
  assert.equal((await call('PUT', `${C}/${customer.id}/active`, { body: { active: true } })).status, 422);
  assert.equal((await call('PUT', `${C}/${randomUUID()}/active`, { body: { version: 1, active: false } })).status, 404);
});

test('다른 매장 원장은 비활성화할 수 없고, 같은 키 재전송은 한 번만 적용된다', async () => {
  const customer = (await call('POST', C, { body: { name: '격리 비활성 합성' } })).body;
  assert.equal((await call('PUT', `/api/shops/${shopB}/customers/${customer.id}/active`, { cookie: ownerB, body: { version: 1, active: false } })).status, 404);
  const key = randomUUID();
  const first = await call('PUT', `${C}/${customer.id}/active`, { body: { version: 1, active: false }, key });
  const again = await call('PUT', `${C}/${customer.id}/active`, { body: { version: 1, active: false }, key });
  assert.equal(first.status, 200);
  assert.equal(again.status, 200, '재전송은 409가 아니라 처음 응답');
  assert.equal(again.replayed, 'true');
  assert.deepEqual(again.body, first.body);
});
