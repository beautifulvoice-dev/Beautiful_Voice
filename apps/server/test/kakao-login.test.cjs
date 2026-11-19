const assert = require('node:assert/strict');
const { test } = require('node:test');
const { authenticateKakaoOwner, kakaoAuthorizationUrl, verifyKakaoCallback } = require('../dist/kakao-login.js');

const config = {
  clientId: 'test-app',
  clientSecret: 'test-secret',
  redirectUri: 'https://example.test/api/auth/kakao/callback',
};
const callback = { code: 'test-code', state: 'browser-state' };

test('uses a server-side code exchange and returns the verified Kakao ID only', async () => {
  const url = kakaoAuthorizationUrl(config, callback.state);
  assert.equal(url.origin, 'https://kauth.kakao.com');
  assert.equal(url.searchParams.get('state'), callback.state);
  assert.equal(url.searchParams.get('redirect_uri'), config.redirectUri);
  assert.equal(url.searchParams.has('client_secret'), false);
  let calls = 0;
  const id = await verifyKakaoCallback(config, callback, callback.state, async (target, options) => {
    calls++;
    assert.equal(options.redirect, 'error');
    if (calls === 1) {
      assert.equal(target, 'https://kauth.kakao.com/oauth/token');
      assert.equal(options.method, 'POST');
      assert.equal(options.body.get('client_secret'), config.clientSecret);
      assert.equal(options.body.get('redirect_uri'), config.redirectUri);
      assert.equal(options.body.get('code'), callback.code);
      return Response.json({ access_token: 'test-token' });
    }
    assert.equal(target, 'https://kapi.kakao.com/v2/user/me');
    assert.equal(options.headers.Authorization, 'Bearer test-token');
    return Response.json({ id: 987654, kakao_account: { email: 'example@example.test' } });
  });
  assert.equal(calls, 2);
  assert.equal(id, '987654');
});

test('rejects invalid state before contacting Kakao', async () => {
  let called = false;
  await assert.rejects(verifyKakaoCallback(config, callback, 'another-state', async () => {
    called = true;
  }), { reason: 'invalid_callback' });
  assert.equal(called, false);
});

test('fails closed on a rejected exchange or an unrepresentable user ID', async () => {
  await assert.rejects(verifyKakaoCallback(config, callback, callback.state,
    async () => new Response(null, { status: 401 })), { reason: 'rejected' });
  const responses = [Response.json({ access_token: 'test-token' }), Response.json({ id: 2 ** 53 })];
  await assert.rejects(verifyKakaoCallback(config, callback, callback.state,
    async () => responses.shift()), { reason: 'unavailable' });
});

test('looks up only the verified Kakao identity and denies unregistered owners', async () => {
  const responses = [Response.json({ access_token: 'test-token' }), Response.json({ id: 987654 })];
  const database = {
    async findKakaoOwner(id) {
      assert.equal(id, '987654');
      return null;
    },
  };
  assert.equal(await authenticateKakaoOwner(config, callback, callback.state, database,
    async () => responses.shift()), null);
  assert.equal(responses.length, 0);
});
