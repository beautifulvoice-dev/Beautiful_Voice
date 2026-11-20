// F-05 Idempotency-Key 저장 — 실제 PostgreSQL에서 돈다(db:test). 매장·데이터는 합성 값만 쓴다.
require('reflect-metadata');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { test, before, after } = require('node:test');
const { Client } = require('pg');
const { DatabaseService } = require('../dist/database.service.js');
const { ApiError } = require('../dist/common/api-error.js');
const { runIdempotent, requestFingerprint } = require('../dist/common/idempotency.js');

const admin = new Client({ connectionString: process.env.DATABASE_MIGRATION_URL });
const db = new DatabaseService();
const [shopA, shopB] = [randomUUID(), randomUUID()];
const fingerprint = requestFingerprint('POST', '/v1/customers', { name: '합성 고객' });

before(async () => {
  assert.ok(process.env.DATABASE_URL);
  assert.ok(process.env.DATABASE_MIGRATION_URL);
  await admin.connect();
  await admin.query('INSERT INTO crm.shop (id, name) VALUES ($1, $3), ($2, $4)', [
    shopA, shopB, 'Synthetic A', 'Synthetic B',
  ]);
  await db.onModuleInit();
});

after(async () => {
  await db.onModuleDestroy();
  await admin.query('DELETE FROM crm.idempotency_key WHERE shop_id IN ($1, $2)', [shopA, shopB]);
  await admin.query('DELETE FROM crm.shop_settings WHERE shop_id IN ($1, $2)', [shopA, shopB]);
  await admin.query('DELETE FROM crm.shop WHERE id IN ($1, $2)', [shopA, shopB]);
  await admin.end();
});

function counter() {
  const handler = async () => {
    handler.calls += 1;
    return { status: 201, body: { id: `created-${handler.calls}` } };
  };
  handler.calls = 0;
  return handler;
}

const send = (shopId, key, handler, print = fingerprint) =>
  db.withShop(shopId, (client) => runIdempotent(client, { key, fingerprint: print }, handler));

test('같은 키·같은 요청을 다시 보내면 한 번만 실행하고 처음 응답을 그대로 돌려준다', async () => {
  const key = randomUUID();
  const handler = counter();
  const first = await send(shopA, key, handler);
  const second = await send(shopA, key, handler);
  assert.equal(handler.calls, 1);
  assert.deepEqual(first, { status: 201, body: { id: 'created-1' }, replayed: false });
  assert.deepEqual(second, { status: 201, body: { id: 'created-1' }, replayed: true });
});

test('같은 키를 다른 요청에 쓰면 422 IDEMPOTENCY_KEY_REUSED, 실행하지 않는다', async () => {
  const key = randomUUID();
  await send(shopA, key, counter());
  const handler = counter();
  const other = requestFingerprint('POST', '/v1/customers', { name: '다른 합성 고객' });
  await assert.rejects(send(shopA, key, handler, other), (error) =>
    error instanceof ApiError && error.status === 422 && error.code === 'IDEMPOTENCY_KEY_REUSED');
  assert.equal(handler.calls, 0);
});

test('동시에 같은 키로 10번 보내도 한 번만 실행되고 모두 같은 응답을 받는다', async () => {
  const key = randomUUID();
  let calls = 0;
  const slow = async (client) => {
    calls += 1;
    await client.query('SELECT pg_sleep(0.2)');
    return { status: 201, body: { id: 'only-one' } };
  };
  const results = await Promise.all(Array.from({ length: 10 }, () =>
    db.withShop(shopA, (client) => runIdempotent(client, { key, fingerprint }, () => slow(client)))));
  assert.equal(calls, 1);
  assert.equal(results.filter((r) => !r.replayed).length, 1);
  for (const result of results) assert.deepEqual(result.body, { id: 'only-one' });
});

test('처리가 실패해 트랜잭션이 롤백되면 키도 남지 않아 다시 시도할 수 있다', async () => {
  const key = randomUUID();
  await assert.rejects(send(shopA, key, async () => { throw new Error('synthetic failure'); }), /synthetic/);
  const handler = counter();
  const retry = await send(shopA, key, handler);
  assert.equal(handler.calls, 1);
  assert.equal(retry.replayed, false);
});

test('매장마다 키가 따로다 — 다른 매장의 같은 키는 새로 실행되고 서로의 응답을 볼 수 없다', async () => {
  const key = randomUUID();
  const a = await send(shopA, key, counter());
  const handlerB = counter();
  const b = await send(shopB, key, handlerB);
  assert.equal(handlerB.calls, 1);
  assert.equal(a.replayed, false);
  assert.equal(b.replayed, false);
  const visible = await db.withShop(shopB, (client) =>
    client.query('SELECT shop_id FROM crm.idempotency_key WHERE key = $1', [key]));
  assert.deepEqual(visible.rows, [{ shop_id: shopB }]);
});

test('매장 범위 밖(withShop 없이)에서는 키를 저장할 수 없다', async () => {
  const unscoped = new Client({ connectionString: process.env.DATABASE_URL });
  await unscoped.connect();
  try {
    await assert.rejects(runIdempotent(unscoped, { key: randomUUID(), fingerprint }, counter()));
  } finally {
    await unscoped.end();
  }
});
