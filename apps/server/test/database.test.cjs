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
      "INSERT INTO crm.user_membership (shop_id, user_id, kakao_user_id) VALUES ($1, $3, '123'), ($2, $4, '456')",
      [shopA, shopB, memberA, memberB],
    );

    await unscoped.connect();
    assert.equal((await unscoped.query('SELECT id FROM crm.shop')).rowCount, 0);
    assert.equal((await unscoped.query('SELECT id FROM crm.user_membership')).rowCount, 0);

    await db.onModuleInit();
    assert.deepEqual(await db.findKakaoOwner('123'), { userId: memberA, shopId: shopA });
    assert.deepEqual(await db.findKakaoOwner('456'), { userId: memberB, shopId: shopB });
    assert.equal(await db.findKakaoOwner('789'), null);
    assert.equal(await db.findOwnerShop(memberA), shopA);
    assert.equal(await db.findOwnerShop(memberB), shopB);
    assert.equal(await db.findOwnerShop(randomUUID()), null);

    await unscoped.query('BEGIN');
    await unscoped.query("SELECT set_config('app.authenticated_user_id', $1, true)", [memberA]);
    assert.deepEqual((await unscoped.query('SELECT shop_id FROM crm.user_membership')).rows, [
      { shop_id: shopA },
    ]);
    assert.equal((await unscoped.query('SELECT id FROM crm.shop')).rowCount, 0);
    await unscoped.query("SELECT set_config('app.shop_id', $1, true)", [shopB]);
    assert.deepEqual((await unscoped.query('SELECT shop_id FROM crm.user_membership')).rows, [
      { shop_id: shopB },
    ]);
    await unscoped.query('COMMIT');
    assert.equal((await unscoped.query('SELECT id FROM crm.user_membership')).rowCount, 0);

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
    const consent = { version: randomUUID(), text: 'Synthetic consent' };
    await db.recordOwnerConsent(memberA, consent);
    await db.recordOwnerConsent(memberA, consent);
    assert.equal(await db.ownerConsentAccepted(memberA, consent.version), true);
    assert.equal(await db.ownerConsentAccepted(memberB, consent.version), false);
    const { rows: [receipt] } = await admin.query(
      'SELECT consent_text, accepted_at FROM crm.owner_consent WHERE user_id = $1', [memberA],
    );
    assert.equal(receipt.consent_text, consent.text);
    assert.ok(receipt.accepted_at instanceof Date);
    await assert.rejects(
      db.withShop(shopA, (client) => client.query('DELETE FROM crm.user_membership')),
      { code: '42501' },
    );

    await db.withShop(shopB, async (client) => {
      assert.deepEqual((await client.query('SELECT name FROM crm.shop')).rows, [
        { name: 'Synthetic B' },
      ]);
    });

    await admin.query('UPDATE crm.user_membership SET user_id = $1 WHERE shop_id = $2', [memberA, shopB]);
    assert.equal(await db.findOwnerShop(memberA), null);
  } finally {
    await db.onModuleDestroy();
    await unscoped.end();
    await admin.query('DELETE FROM crm.owner_consent WHERE user_id IN ($1, $2)', [memberA, memberB]);
    await admin.query('DELETE FROM crm.user_membership WHERE shop_id IN ($1, $2)', [shopA, shopB]);
    await admin.query('DELETE FROM crm.shop_settings WHERE shop_id IN ($1, $2)', [shopA, shopB]);
    await admin.query('DELETE FROM crm.shop WHERE id IN ($1, $2)', [shopA, shopB]);
    await admin.end();
  }
});

test('AI cannot write settings, supervisors cannot write CRM, and owners cannot append history directly', async () => {
  assert.ok(process.env.DATABASE_MIGRATION_URL);
  const db = new Client({ connectionString: process.env.DATABASE_MIGRATION_URL });
  await db.connect();
  try {
    for (const [role, sql] of [
      ['bv_ai_executor', 'UPDATE crm.shop_settings SET business_hours = business_hours'],
      ['bv_ops', "UPDATE crm.customer SET name = 'Synthetic customer'"],
      ['bv_app', 'INSERT INTO crm.appointment_event DEFAULT VALUES'],
    ]) {
      await db.query('BEGIN');
      try {
        await db.query(`SET LOCAL ROLE ${role}`);
        assert.equal((await db.query('SELECT current_user')).rows[0].current_user, role);
        await assert.rejects(db.query(sql), { code: '42501' });
      } finally {
        await db.query('ROLLBACK');
      }
    }
  } finally {
    await db.end();
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
