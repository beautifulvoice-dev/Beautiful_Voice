// BEA-172 고객 API — 실제 PostgreSQL + Nest 앱으로 계약 #42를 확인한다.
// 수용 기준: 이름만으로 등록 / 이름·전화가 같은 고객 여러 명(AC-CRM-8) / 고치고, 이름이나 전화로 찾는다 /
// 두 곳에서 같은 고객을 고치면 뒤의 저장이 거부된다.
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

const SECRET = 'cf'.repeat(32);
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
    for (const table of ['idempotency_key', 'customer', 'shop_settings', 'user_membership']) {
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
const add = async (body) => (await call('POST', C, { body })).body;

test('이름만으로 등록된다, 잘못된 값은 칸별로 422', async () => {
  const only = await call('POST', C, { body: { name: '  합성  고객 ' } });
  assert.equal(only.status, 201);
  assert.deepEqual(
    { ...only.body, id: undefined, createdAt: undefined, updatedAt: undefined },
    { id: undefined, createdAt: undefined, updatedAt: undefined, version: 1, name: '합성 고객', phone: null, memo: null,
      birthdate: null, address: null, active: true, deactivatedAt: null });
  const full = await call('POST', C, { body: { name: '합성 전체', phone: '010-0000-0009', memo: ' 메모\n둘째 줄 ', birthdate: '1990-02-28', address: '합성시' } });
  assert.deepEqual([full.body.phone, full.body.memo, full.body.birthdate], ['01000000009', '메모\n둘째 줄', '1990-02-28']);

  const bad = await call('POST', C, { body: { name: ' ', phone: '1234', birthdate: '1990-02-30', memo: 3 } });
  assert.equal(bad.status, 422);
  assert.deepEqual(bad.body.details.fields.map((f) => f.field + ':' + f.code).sort(),
    ['birthdate:BIRTHDATE_INVALID', 'memo:INVALID_TYPE', 'name:NAME_REQUIRED', 'phone:PHONE_INVALID_FORMAT']);
  assert.equal(JSON.stringify(bad.body).includes('1234'), false, '오류에 입력값(개인정보)을 되돌려 보내지 않는다');
});

test('이름·전화가 같은 고객도 여러 명 둘 수 있고, 동명이인 확인은 비활성 고객도 후보로 보여 준다', async () => {
  const first = await add({ name: '동명 합성', phone: '01000000001' });
  const second = await add({ name: '동명 합성', phone: '01000000001' });
  assert.notEqual(first.id, second.id, 'AC-CRM-8');
  const third = await add({ name: '동명합성', phone: '01000000002' });
  await admin.query('UPDATE crm.customer SET active = false, deactivated_at = now() WHERE id = $1', [third.id]);

  const check = await call('POST', `${C}/same-name-check`, { body: { name: '동명  합성', phone: '010-0000-0001' }, key: null });
  assert.equal(check.status, 200);
  assert.equal(check.body.needsReview, true);
  assert.deepEqual(check.body.candidates.map((c) => [c.customerId, c.hint, c.active]), [
    [first.id, 'same_phone', true], [second.id, 'same_phone', true], [third.id, 'different_phone', false],
  ]);
  const self = await call('POST', `${C}/same-name-check`, { body: { name: '동명 합성', phone: null, excludeId: first.id }, key: null });
  assert.ok(!self.body.candidates.some((c) => c.customerId === first.id), '수정 중인 자신은 빠진다');
  assert.deepEqual((await call('POST', `${C}/same-name-check`, { body: { name: '없는 이름' }, key: null })).body, { needsReview: false, candidates: [] });
});

test('검색: 이름은 띄어쓰기·대소문자 무시 부분 일치, 전화는 숫자 3자리 이상, 비활성은 기본 제외', async () => {
  const kim = await add({ name: '검색 김민지', phone: '01055550123' });
  const lee = await add({ name: 'Search Lee', phone: '0212345678' });
  const pct = await add({ name: '검색 100%할인' });
  const names = async (q, extra = '') => (await call('GET', `${C}?q=${encodeURIComponent(q)}&limit=100${extra}`)).body.items.map((c) => c.id);
  assert.deepEqual(await names('김 민지'), [kim.id]);
  assert.deepEqual(await names('searchlee'), [lee.id]);
  assert.deepEqual(await names('5550'), [kim.id]);
  assert.deepEqual(await names('010-5555'), [kim.id], '하이픈이 섞여도 숫자로');
  assert.deepEqual(await names('55'), [], '2자리 숫자는 전화로 찾지 않는다');
  assert.deepEqual(await names('%할인'), [pct.id], '%는 글자로(아무 글자가 아님)');
  assert.deepEqual(await names('검색%'), [], '%가 와일드카드면 "검색…" 둘이 다 걸린다');
  await admin.query('UPDATE crm.customer SET active = false, deactivated_at = now() WHERE id = $1', [lee.id]);
  assert.deepEqual(await names('searchlee'), []);
  assert.deepEqual(await names('searchlee', '&includeInactive=true'), [lee.id]);
});

test('목록은 이름순, 커서로 넘겨도 빠짐·중복 없음, 잘못된 커서·limit은 400', async () => {
  const all = (await call('GET', `${C}?limit=100`)).body.items;
  const seen = [];
  let cursor = null;
  do {
    const page = await call('GET', `${C}?limit=2${cursor ? '&cursor=' + cursor : ''}`);
    assert.ok(page.body.items.length <= 2);
    seen.push(...page.body.items.map((c) => c.id));
    cursor = page.body.nextCursor;
  } while (cursor);
  assert.deepEqual(seen, all.map((c) => c.id));
  const sorted = [...all].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : 1));
  assert.deepEqual(all.map((c) => c.id), sorted.map((c) => c.id), '유니코드(가나다) 순');
  assert.equal((await call('GET', `${C}?cursor=***`)).status, 400);
  assert.equal((await call('GET', `${C}?limit=101`)).status, 400);
});

test('수정: 보낸 칸만, 두 곳에서 같은 version으로 고치면 뒤의 저장은 409, 바뀐 게 없으면 version 그대로', async () => {
  const c = await add({ name: '수정 합성', phone: '01000000003', memo: '처음' });
  const one = await call('PATCH', `${C}/${c.id}`, { body: { version: 1, phone: null } });
  assert.equal(one.status, 200);
  assert.deepEqual([one.body.name, one.body.phone, one.body.memo, one.body.version], ['수정 합성', null, '처음', 2]);
  const two = await call('PATCH', `${C}/${c.id}`, { body: { version: 1, memo: '늦게 온 수정' } });
  assert.equal(two.status, 409);
  assert.deepEqual(two.body.details, { currentVersion: 2 });
  assert.equal((await call('GET', `${C}/${c.id}`)).body.memo, '처음', '거부된 수정은 반영되지 않는다');

  const same = await call('PATCH', `${C}/${c.id}`, { body: { version: 2, name: ' 수정  합성 ' } });
  assert.equal(same.body.version, 2, '정규화하면 같은 이름 → 저장 안 함');
  assert.equal((await call('PATCH', `${C}/${c.id}`, { body: { version: 2, name: '' } })).status, 422);
  assert.equal((await call('PATCH', `${C}/${c.id}`, { body: { name: 'x' } })).status, 422, 'version 필수');
  assert.equal((await call('PATCH', `${C}/${randomUUID()}`, { body: { version: 1, name: 'x' } })).status, 404);
});

test('다른 매장 원장은 404, 같은 키 재전송은 한 번만 등록', async () => {
  const c = await add({ name: '격리 합성' });
  assert.equal((await call('GET', `${C}/${c.id}`, { cookie: ownerB })).status, 404);
  assert.equal((await call('GET', `/api/shops/${shopB}/customers/${c.id}`, { cookie: ownerB })).status, 404);
  assert.deepEqual((await call('GET', `/api/shops/${shopB}/customers?q=${encodeURIComponent('격리')}`, { cookie: ownerB })).body.items, []);

  const key = randomUUID();
  const first = await call('POST', C, { body: { name: '재전송 합성' }, key });
  const again = await call('POST', C, { body: { name: '재전송 합성' }, key });
  assert.equal(again.replayed, 'true');
  assert.equal(again.body.id, first.body.id);
  assert.equal((await call('GET', `${C}?q=${encodeURIComponent('재전송')}`)).body.items.length, 1);
});
