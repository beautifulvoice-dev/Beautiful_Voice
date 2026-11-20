require('reflect-metadata');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { test } = require('node:test');
const { Client } = require('pg');
const { DatabaseService } = require('../dist/database.service.js');

test('M1 reference data is private to its shop and staff are not login members', async () => {
  const admin = new Client({ connectionString: process.env.DATABASE_MIGRATION_URL });
  const db = new DatabaseService();
  const [shopA, shopB] = [randomUUID(), randomUUID()];

  await admin.connect();
  try {
    await admin.query('INSERT INTO crm.shop (id, name) VALUES ($1, $3), ($2, $4)',
      [shopA, shopB, 'Synthetic A', 'Synthetic B']);
    await admin.query('INSERT INTO crm.shop_settings (shop_id) VALUES ($1), ($2)', [shopA, shopB]);
    await db.onModuleInit();
    await db.withShop(shopA, async (client) => {
      await client.query("INSERT INTO crm.staff (shop_id, name) VALUES ($1, 'Synthetic staff')", [shopA]);
      await client.query("INSERT INTO crm.menu (shop_id, name, default_duration_min, default_prep_min) VALUES ($1, 'Synthetic menu', 60, 20)", [shopA]);
      await client.query("INSERT INTO crm.customer (shop_id, name, created_source) VALUES ($1, 'Synthetic customer', 'manual'), ($1, 'Synthetic customer', 'manual')", [shopA]);
      await client.query("INSERT INTO crm.shop_closure (shop_id, kind, weekday) VALUES ($1, 'weekly', 7)", [shopA]);
      assert.equal((await client.query('SELECT id FROM crm.user_membership')).rowCount, 0);
      assert.equal((await client.query('SELECT name FROM crm.customer')).rowCount, 2);
      const hours = { 1: [{ open: '10:00', close: '18:00' }] };
      const { rows: [settings] } = await client.query(
        'UPDATE crm.shop_settings SET location_text = $1, business_hours = $2 RETURNING business_hours',
        ['Synthetic location', hours],
      );
      assert.deepEqual(settings.business_hours, hours);
      assert.equal((await client.query('UPDATE crm.shop_settings SET business_hours = NULL RETURNING business_hours')).rows[0].business_hours, null);
    });
    await db.withShop(shopB, async (client) => {
      assert.equal((await client.query('SELECT id FROM crm.staff')).rowCount, 0);
      assert.equal((await client.query('SELECT id FROM crm.menu')).rowCount, 0);
      assert.equal((await client.query('SELECT id FROM crm.customer')).rowCount, 0);
      assert.equal((await client.query('SELECT id FROM crm.shop_closure')).rowCount, 0);
      assert.equal((await client.query('DELETE FROM crm.shop_closure WHERE shop_id = $1', [shopA])).rowCount, 0);
      assert.equal((await client.query('SELECT location_text FROM crm.shop_settings')).rows[0].location_text, null);
    });
    await db.withShop(shopA, async (client) => {
      assert.equal((await client.query('DELETE FROM crm.shop_closure')).rowCount, 1);
    });
    await assert.rejects(db.withShop(shopB, (client) => client.query(
      "INSERT INTO crm.staff (shop_id, name) VALUES ($1, 'Cross-shop attempt')", [shopA],
    )), { code: '42501' });
    await assert.rejects(db.withShop(shopA, (client) => client.query('DELETE FROM crm.customer')), { code: '42501' });
    await assert.rejects(db.withShop(shopA, (client) => client.query(
      "INSERT INTO crm.shop_closure (shop_id, kind, weekday) VALUES ($1, 'weekly', NULL)", [shopA],
    )), { code: '23514' });
    await assert.rejects(db.withShop(shopA, (client) => client.query(
      "UPDATE crm.shop_settings SET business_hours = '[]'::jsonb",
    )), { code: '23514' });
  } finally {
    try {
      await db.onModuleDestroy();
      for (const table of ['shop_closure', 'customer', 'staff', 'menu', 'shop_settings']) {
        await admin.query(`DELETE FROM crm.${table} WHERE shop_id IN ($1, $2)`, [shopA, shopB]);
      }
      await admin.query('DELETE FROM crm.shop WHERE id IN ($1, $2)', [shopA, shopB]);
    } finally {
      await admin.end();
    }
  }
});
