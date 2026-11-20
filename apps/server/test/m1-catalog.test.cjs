// BEA-167 메뉴·담당자 API — 실제 PostgreSQL + Nest 앱으로 계약 #42를 확인한다.
// 수용 기준: 등록·수정·숨김이 된다 / 메뉴의 기본 시간이 저장된다 / 원장 자신도 담당자로 등록할 수 있다.
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
const { CatalogController } = require('../dist/settings/catalog.controller.js');
const { CatalogService } = require('../dist/settings/catalog.service.js');
const { signCookie } = require('../dist/owner-session.js');

const SECRET = 'ce'.repeat(32);
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
  Module({ controllers: [CatalogController], providers: [DatabaseService, CatalogService] })(TestModule);
  app = await NestFactory.create(TestModule, { logger: false });
  app.useGlobalFilters(new ApiExceptionFilter());
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
});

after(async () => {
  await app?.close();
  try {
    for (const table of ['idempotency_key', 'menu', 'staff', 'shop_settings', 'user_membership']) {
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

test('메뉴 등록 — 기본 관리·준비 시간이 저장되고 목록에 나온다, 잘못된 값은 422', async () => {
  const facial = await call('POST', `${A}/menus`, { body: { name: '  합성 페이셜  ', defaultDurationMin: 60, defaultPrepMin: 20 } });
  assert.equal(facial.status, 201);
  assert.equal(facial.body.name, '합성 페이셜');
  assert.equal(facial.body.defaultDurationMin, 60);
  assert.equal(facial.body.defaultPrepMin, 20);
  assert.equal(facial.body.active, true);
  assert.equal(facial.body.version, 1);
  assert.match(facial.body.createdAt, /^\d{4}-\d{2}-\d{2}T/);
  const plain = await call('POST', `${A}/menus`, { body: { name: '합성 상담' } });
  assert.equal(plain.body.defaultDurationMin, null, '기본 시간은 비워도 된다(S3)');

  const listed = await call('GET', `${A}/menus`);
  assert.deepEqual(listed.body.items.map((m) => m.name), ['합성 페이셜', '합성 상담'], '등록 순서');

  const bad = await call('POST', `${A}/menus`, { body: { name: ' ', defaultDurationMin: 0, defaultPrepMin: '20' } });
  assert.equal(bad.status, 422);
  assert.deepEqual(bad.body.details.fields, [
    { field: 'name', code: 'NAME_REQUIRED' }, { field: 'defaultDurationMin', code: 'INVALID_MINUTES' }, { field: 'defaultPrepMin', code: 'INVALID_MINUTES' },
  ]);
  assert.equal((await call('GET', `${A}/menus`, { cookie: ownerB })).status, 404, '다른 매장 원장');
});

test('메뉴 수정 — 보낸 칸만 바뀌고 version이 오른다, 옛 version은 409, 없는 메뉴는 404', async () => {
  const menu = (await call('POST', `${A}/menus`, { body: { name: '합성 바디', defaultDurationMin: 90, defaultPrepMin: 10 } })).body;
  const edited = await call('PATCH', `${A}/menus/${menu.id}`, { body: { version: 1, defaultPrepMin: null } });
  assert.equal(edited.status, 200);
  assert.deepEqual(
    { name: edited.body.name, d: edited.body.defaultDurationMin, p: edited.body.defaultPrepMin, v: edited.body.version },
    { name: '합성 바디', d: 90, p: null, v: 2 });

  const stale = await call('PATCH', `${A}/menus/${menu.id}`, { body: { version: 1, name: '늦게 온 수정' } });
  assert.equal(stale.status, 409);
  assert.deepEqual(stale.body.details, { currentVersion: 2 });
  assert.equal((await call('PATCH', `${A}/menus/${menu.id}`, { body: { name: 'version 없음' } })).status, 422);
  assert.equal((await call('PATCH', `${A}/menus/${randomUUID()}`, { body: { version: 1, name: 'x' } })).status, 404);
  assert.equal((await call('PATCH', `${A}/menus/${menu.id}`, { body: { version: 2, name: '' } })).status, 422);
  const after = (await call('GET', `${A}/menus`)).body.items.find((m) => m.id === menu.id);
  assert.equal(after.name, '합성 바디', '실패한 수정은 아무것도 바꾸지 않는다');
});

test('숨김 — active=false면 기본 목록에서 빠지고 includeInactive면 보인다, 다시 켤 수 있다', async () => {
  const menu = (await call('POST', `${A}/menus`, { body: { name: '합성 시즌 메뉴' } })).body;
  const hidden = await call('PATCH', `${A}/menus/${menu.id}`, { body: { version: 1, active: false } });
  assert.equal(hidden.body.active, false);
  assert.ok(!(await call('GET', `${A}/menus`)).body.items.some((m) => m.id === menu.id));
  assert.ok((await call('GET', `${A}/menus?includeInactive=true`)).body.items.some((m) => m.id === menu.id));
  assert.equal((await call('PATCH', `${A}/menus/${menu.id}`, { body: { version: 2, active: 'no' } })).status, 422);
  assert.equal((await call('PATCH', `${A}/menus/${menu.id}`, { body: { version: 2, active: true } })).body.active, true);
});

test('담당자 — 원장 자신도 등록, 이름 수정·숨김, 다른 매장 원장은 못 고친다', async () => {
  const owner = await call('POST', `${A}/staff`, { body: { name: '원장' } });
  assert.equal(owner.status, 201);
  assert.deepEqual({ name: owner.body.name, active: owner.body.active, version: owner.body.version }, { name: '원장', active: true, version: 1 });
  assert.equal((await call('POST', `${A}/staff`, { body: {} })).status, 422);

  const renamed = await call('PATCH', `${A}/staff/${owner.body.id}`, { body: { version: 1, name: '원장(합성)' } });
  assert.equal(renamed.body.name, '원장(합성)');
  assert.equal(renamed.body.version, 2);
  // B 원장이 자기 매장 경로로 A의 담당자 id를 고치려 해도 없음(RLS + shop_id 조건)
  assert.equal((await call('PATCH', `/api/shops/${shopB}/staff/${owner.body.id}`, { cookie: ownerB, body: { version: 2, name: 'x' } })).status, 404);
  const hidden = await call('PATCH', `${A}/staff/${owner.body.id}`, { body: { version: 2, active: false } });
  assert.equal(hidden.body.active, false);
  assert.deepEqual((await call('GET', `${A}/staff`)).body.items, []);
  assert.equal((await call('GET', `${A}/staff?includeInactive=true`)).body.items.length, 1);
});

test('같은 키로 재전송하면 메뉴는 한 번만 생긴다', async () => {
  const key = randomUUID();
  const body = { name: '합성 재전송 메뉴', defaultDurationMin: 30 };
  const first = await call('POST', `${A}/menus`, { body, key });
  const again = await call('POST', `${A}/menus`, { body, key });
  assert.equal(again.replayed, 'true');
  assert.deepEqual(again.body, first.body);
  const same = (await call('GET', `${A}/menus`)).body.items.filter((m) => m.name === body.name);
  assert.equal(same.length, 1);
});

test('DB integer 범위를 넘는 분 값은 등록·수정 모두 500이 아니라 422(#39 validateMenu 상한)', async () => {
  const tooBig = 2147483648;
  const created = await call('POST', `${A}/menus`, { body: { name: '합성 범위 메뉴', defaultDurationMin: tooBig } });
  assert.equal(created.status, 422);
  assert.deepEqual(created.body.details.fields, [{ field: 'defaultDurationMin', code: 'INVALID_MINUTES' }]);
  const menu = (await call('POST', `${A}/menus`, { body: { name: '합성 범위 메뉴', defaultDurationMin: 2147483647, defaultPrepMin: 0 } })).body;
  assert.equal(menu.defaultDurationMin, 2147483647, '최댓값은 저장된다');
  const edited = await call('PATCH', `${A}/menus/${menu.id}`, { body: { version: 1, defaultPrepMin: tooBig } });
  assert.equal(edited.status, 422);
  assert.deepEqual(edited.body.details.fields, [{ field: 'defaultPrepMin', code: 'INVALID_MINUTES' }]);
});
