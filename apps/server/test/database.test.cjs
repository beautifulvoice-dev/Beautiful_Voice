require('reflect-metadata');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { test } = require('node:test');
const { Client } = require('pg');
const { DatabaseService } = require('../dist/database.service.js');

test('the app role can read and change only its current shop', async () => {
  assert.ok(process.env.DATABASE_URL);
  assert.ok(process.env.DATABASE_MIGRATION_URL);
  const admin = new Client({ connectionString: process.env.DATABASE_MIGRATION_URL });
  const unscoped = new Client({ connectionString: process.env.DATABASE_URL });
  const db = new DatabaseService();
  const [shopA, shopB] = [randomUUID(), randomUUID()];
  const [memberA, memberB] = [randomUUID(), randomUUID()];

  await admin.connect();
  try {
    await admin.query('INSERT INTO crm.shop (id, name) VALUES ($1, $3), ($2, $4)', [
      shopA, shopB, 'Synthetic A', 'Synthetic B',
    ]);
    await admin.query(
      'INSERT INTO crm.user_membership (shop_id, user_id) VALUES ($1, $3), ($2, $4)',
      [shopA, shopB, memberA, memberB],
    );

    await unscoped.connect();
    assert.equal((await unscoped.query('SELECT id FROM crm.shop')).rowCount, 0);
    assert.equal((await unscoped.query('SELECT id FROM crm.user_membership')).rowCount, 0);

    await db.onModuleInit();
    await db.withShop(shopA, async (client) => {
      assert.deepEqual((await client.query('SELECT id FROM crm.shop')).rows, [{ id: shopA }]);
      assert.deepEqual((await client.query('SELECT user_id FROM crm.user_membership')).rows, [
        { user_id: memberA },
      ]);
      assert.equal((await client.query('UPDATE crm.shop SET name = $1', ['Updated A'])).rowCount, 1);
      assert.equal((await client.query('UPDATE crm.shop SET name = $1 WHERE id = $2', [
        'Blocked', shopB,
      ])).rowCount, 0);
    });
    await assert.rejects(
      db.withShop(shopA, (client) => client.query('DELETE FROM crm.user_membership')),
      { code: '42501' },
    );

    await db.withShop(shopB, async (client) => {
      assert.deepEqual((await client.query('SELECT name FROM crm.shop')).rows, [
        { name: 'Synthetic B' },
      ]);
    });
  } finally {
    await db.onModuleDestroy();
    await unscoped.end();
    await admin.query('DELETE FROM crm.user_membership WHERE shop_id IN ($1, $2)', [shopA, shopB]);
    await admin.query('DELETE FROM crm.shop WHERE id IN ($1, $2)', [shopA, shopB]);
    await admin.end();
  }
});

test('startup rejects the migration account', async () => {
  assert.ok(process.env.DATABASE_URL);
  assert.ok(process.env.DATABASE_MIGRATION_URL);
  const appUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = process.env.DATABASE_MIGRATION_URL;
  try {
    await assert.rejects(new DatabaseService().onModuleInit(), /unprivileged CRM application role/);
  } finally {
    process.env.DATABASE_URL = appUrl;
  }
});
