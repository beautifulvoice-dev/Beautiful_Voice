const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { test } = require('node:test');
const { createSolapiSender } = require('../dist/sms/solapi-sender');

const settings = { apiKey: 'fake-key', apiSecret: 'fake-secret', from: '01000000000' };
const message = { id: 'local-id', recipient: '01000001111', body: '합성 메시지', type: 'LMS', title: '합성 매장' };

test('signs requests, preserves message type, and includes the stable correlation key', async () => {
  const send = createSolapiSender(settings, async (url, init) => {
    assert.equal(url, 'https://api.solapi.com/messages/v4/send-many/detail');
    const match = /^HMAC-SHA256 apiKey=fake-key, date=([^,]+), salt=([a-f0-9]{32}), signature=([a-f0-9]{64})$/.exec(init.headers.Authorization);
    assert.ok(match);
    assert.equal(match[3], createHmac('sha256', settings.apiSecret).update(match[1] + match[2]).digest('hex'));
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
    assert.deepEqual(JSON.parse(init.body), {
      showMessageList: true,
      messages: [{
        from: settings.from, to: message.recipient, text: message.body, type: 'LMS',
        subject: message.title, customFields: { bvIdempotencyKey: message.id },
      }],
    });
    return Response.json({ messageList: [{ statusCode: '2000', messageId: 'provider-id' }] });
  });
  assert.deepEqual(await send(message), { status: 'sent', providerId: 'provider-id' });
});

test('distinguishes rejected, rate limited, ambiguous and account failures', async () => {
  const cases = [
    [429, {}, 'not_accepted'],
    [503, {}, 'unknown'],
    [403, {}, 'halt'],
    [200, { failedMessageList: [{ statusCode: '1030' }] }, 'halt'],
    [200, { failedMessageList: [{ statusCode: '3040' }] }, 'halt'],
    [200, { failedMessageList: [{ statusCode: '3000' }] }, 'failed'],
    [200, { messageList: [{ statusCode: '2000' }] }, 'unknown'],
  ];
  for (const [status, body, expected] of cases) {
    const send = createSolapiSender(settings, async () => Response.json(body, { status }));
    assert.deepEqual(await send(message), { status: expected });
  }
});


test('scheduler is opt-in, ticks every minute, and clears its interval on shutdown', async () => {
  require('reflect-metadata');
  const { SmsDispatchScheduler } = require('../dist/sms/sms-dispatch-scheduler');
  const names = ['BV_SMS_DISPATCH_ENABLED', 'BV_SMS_DISPATCH_SHOP_ID', 'BV_SOLAPI_API_KEY',
    'BV_SOLAPI_API_SECRET', 'BV_SOLAPI_SENDER', 'DATABASE_SYSTEM_URL', 'BV_SMS_DISPATCH_TEST_RECIPIENT'];
  const previous = names.map(name => process.env[name]);
  const { setInterval, clearInterval, fetch } = global;
  const handle = { unref() {} };
  let tick;
  let transactionCount = 0;
  try {
    const scheduler = new SmsDispatchScheduler({
      async withSystem(run) {
        transactionCount++;
        return run({ query: async () => ({ rows: [] }) });
      },
    });
    global.setInterval = (run, ms) => {
      assert.equal(ms, 60_000);
      tick = run;
      return handle;
    };
    global.clearInterval = timer => {
      assert.equal(timer, handle);
      tick = undefined;
    };
    global.fetch = async () => { assert.fail('No due row should reach the provider'); };
    process.env.BV_SMS_DISPATCH_ENABLED = 'false';
    scheduler.onApplicationBootstrap();
    assert.equal(tick, undefined);

    Object.assign(process.env, {
      BV_SMS_DISPATCH_ENABLED: 'true', BV_SMS_DISPATCH_SHOP_ID: '00000000-0000-4000-8000-000000000001',
      BV_SOLAPI_API_KEY: settings.apiKey, BV_SOLAPI_API_SECRET: settings.apiSecret,
      BV_SOLAPI_SENDER: settings.from, DATABASE_SYSTEM_URL: 'synthetic',
    });
    process.env.BV_SMS_DISPATCH_TEST_RECIPIENT = '02-000-0000';
    assert.throws(() => scheduler.onApplicationBootstrap(), /valid mobile number/);
    process.env.BV_SMS_DISPATCH_TEST_RECIPIENT = '+82 10-0000-1111';
    scheduler.onApplicationBootstrap();
    assert.equal(transactionCount, 0);
    tick();
    tick();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(transactionCount, 2);
    scheduler.onModuleDestroy();
    assert.equal(tick, undefined);
  } finally {
    Object.assign(global, { setInterval, clearInterval, fetch });
    for (const [index, name] of names.entries()) {
      if (previous[index] === undefined) delete process.env[name];
      else process.env[name] = previous[index];
    }
  }
});
