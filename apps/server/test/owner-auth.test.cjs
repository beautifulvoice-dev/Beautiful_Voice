require('reflect-metadata');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { test } = require('node:test');
const { Module } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const { DatabaseService } = require('../dist/database.service.js');
const { OwnerAuthController } = require('../dist/owner-auth.controller.js');
const { verifyCookie, signCookie } = require('../dist/owner-session.js');

test('browser login issues a session and only authorizes the current shop', async (t) => {
  const userId = randomUUID();
  const shopId = randomUUID();
  const otherShop = randomUUID();
  const shop = { id: shopId, name: 'Synthetic shop' };
  let isOwner = true;
  let membership = shopId;
  let kakaoCalls = 0;
  let shopReads = 0;
  const browserFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url) => {
    kakaoCalls++;
    if (url === 'https://kauth.kakao.com/oauth/token') return Response.json({ access_token: 'test-token' });
    assert.equal(url, 'https://kapi.kakao.com/v2/user/me');
    return Response.json({ id: 12345 });
  });
  const database = {
    async findKakaoOwner(id) {
      assert.equal(id, '12345');
      return isOwner ? { shopId, userId } : null;
    },
    async findOwnerShop(id) {
      assert.equal(id, userId);
      return membership;
    },
    async withShop(id, run) {
      assert.equal(id, shopId);
      shopReads++;
      return run({
        async query(_sql, parameters) {
          assert.deepEqual(parameters, [shopId]);
          return { rows: [shop] };
        },
      });
    },
  };
  const settings = {
    KAKAO_CLIENT_ID: 'test-app',
    KAKAO_CLIENT_SECRET: 'test-secret',
    KAKAO_REDIRECT_URI: 'https://example.test/api/auth/kakao/callback',
    BV_SESSION_SECRET: 'ab'.repeat(32),
  };
  const originalEnv = Object.fromEntries(Object.keys(settings).map((key) => [key, process.env[key]]));
  Object.assign(process.env, settings);
  t.after(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  class TestModule {}
  Module({ controllers: [OwnerAuthController], providers: [{ provide: DatabaseService, useValue: database }] })(TestModule);
  const app = await NestFactory.create(TestModule, { logger: false });
  t.after(() => app.close());
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  function request(path, cookie) {
    return browserFetch(base + path, { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} });
  }
  const start = await request('/api/auth/kakao/start');
  assert.equal(start.status, 302);
  assert.equal(start.headers.get('cache-control'), 'no-store');
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  assert.ok(state);
  const [stateHeader] = start.headers.getSetCookie();
  assert.match(stateHeader, /HttpOnly; SameSite=Lax; Secure/);
  const stateCookie = stateHeader.split(';')[0];
  const callback = '/api/auth/kakao/callback?code=test-code&state=';
  const wrongState = await request(callback + 'wrong', stateCookie);
  assert.equal(wrongState.status, 401);
  assert.match(wrongState.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal(kakaoCalls, 0);
  assert.equal((await request(callback + state)).status, 401);

  isOwner = false;
  const unknownOwner = await request(callback + state, stateCookie);
  assert.equal(unknownOwner.status, 403);
  assert.deepEqual(await unknownOwner.json(), {
    code: 'OWNER_NOT_REGISTERED', message: '등록된 원장 계정이 아닙니다.',
  });
  isOwner = true;
  const login = await request(callback + state, stateCookie);
  assert.equal(login.status, 302);
  assert.equal(login.headers.get('location'), '/');
  assert.equal(login.headers.get('referrer-policy'), 'no-referrer');
  const [cleared, issued] = login.headers.getSetCookie();
  assert.match(cleared, /^bv_oauth_state=; Max-Age=0/);
  assert.match(issued, /^bv_session=.+Path=\/api; HttpOnly; SameSite=Lax; Secure$/);
  const sessionCookie = issued.split(';')[0];
  const signatureAt = sessionCookie.lastIndexOf('.') + 1;
  const tampered = sessionCookie.slice(0, signatureAt) + (sessionCookie[signatureAt] === 'x' ? 'y' : 'x')
    + sessionCookie.slice(signatureAt + 1);

  assert.equal((await request('/api/auth/session', tampered)).status, 401);
  assert.equal((await request('/api/shops/' + shopId)).status, 401);
  const session = await request('/api/auth/session', sessionCookie);
  assert.equal(session.status, 200);
  assert.deepEqual(await session.json(), { shopId });
  const blocked = await request('/api/shops/' + otherShop, sessionCookie);
  assert.equal(blocked.status, 404);
  assert.equal((await blocked.json()).code, 'SHOP_NOT_FOUND');
  assert.equal(shopReads, 0);
  const allowed = await request('/api/shops/' + shopId, sessionCookie);
  assert.equal(allowed.status, 200);
  assert.deepEqual(await allowed.json(), shop);
  membership = otherShop;
  assert.equal((await request('/api/auth/session', sessionCookie)).status, 401);
});

test('expired cookies or cookies signed for a different purpose do not open a session', () => {
  const key = Buffer.alloc(32, 5);
  assert.equal(verifyCookie(key, 'owner-session', signCookie(key, 'owner-session', 'test', -1)), null);
  assert.equal(verifyCookie(key, 'owner-session', signCookie(key, 'oauth-state', 'test', 10)), null);
});
