require('reflect-metadata');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { test, before, after } = require('node:test');
const { Client } = require('pg');
const { DatabaseService } = require('../dist/database.service.js');

const admin = new Client({ connectionString: process.env.DATABASE_MIGRATION_URL });
const db = new DatabaseService();
const [shopA, shopB, customerA, customerB, menuA, menuB, staffA, staffA2, staffB] =
  Array.from({ length: 9 }, () => randomUUID());

before(async () => {
  assert.ok(process.env.DATABASE_URL && process.env.DATABASE_MIGRATION_URL);
  await admin.connect();
  await admin.query("INSERT INTO crm.shop (id, name) VALUES ($1, 'Synthetic A'), ($2, 'Synthetic B')", [shopA, shopB]);
  await admin.query("INSERT INTO crm.customer (id, shop_id, name, created_source) VALUES ($1, $2, 'A', 'manual'), ($3, $4, 'B', 'manual')",
    [customerA, shopA, customerB, shopB]);
  await admin.query("INSERT INTO crm.menu (id, shop_id, name) VALUES ($1, $2, 'A'), ($3, $4, 'B')",
    [menuA, shopA, menuB, shopB]);
  await admin.query("INSERT INTO crm.staff (id, shop_id, name) VALUES ($1, $2, 'A1'), ($3, $2, 'A2'), ($4, $5, 'B1')",
    [staffA, shopA, staffA2, staffB, shopB]);
  await db.onModuleInit();
});

after(async () => {
  await db.onModuleDestroy();
  try {
    if (!process.env.DATABASE_MIGRATION_URL) return;
    for (const table of ['appointment_m1', 'staff', 'menu', 'customer', 'shop_settings']) {
      await admin.query(`DELETE FROM crm.${table} WHERE shop_id IN ($1, $2)`, [shopA, shopB]);
    }
    await admin.query('DELETE FROM crm.shop WHERE id IN ($1, $2)', [shopA, shopB]);
  } finally {
    await admin.end();
  }
});

function add({ start, staff = staffA, customer = customerA, menu = menuA, prep = 20, duration = 60, status = 'scheduled' }) {
  return db.withShop(shopA, async (client) => {
    const { rows: [row] } = await client.query(
      `INSERT INTO crm.appointment_m1
         (shop_id, customer_id, menu_id, staff_id, start_at, duration_min, prep_min, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, version, lower(occupied) AS starts, upper(occupied) AS ends`,
      [shopA, customer, menu, staff, start, duration, prep, status],
    );
    return row;
  });
}

test('management starts at 14:00, with preparation occupying 13:40 to 15:00', async () => {
  const first = await add({ start: '2026-12-01T14:00:00+09:00' });
  assert.equal(first.starts.toISOString(), '2026-12-01T04:40:00.000Z');
  assert.equal(first.ends.toISOString(), '2026-12-01T06:00:00.000Z');
  await assert.rejects(add({ start: '2026-12-01T13:50:00+09:00', duration: 5, prep: 0 }),
    { code: '23P01', constraint: 'appointment_m1_staff_overlap' });
  assert.ok(await add({ start: '2026-12-01T14:00:00+09:00', staff: staffA2, menu: null }));
  assert.ok(await add({ start: '2026-12-01T15:00:00+09:00', prep: 0 }));
});

test('same-shop references and read access are enforced independently by PostgreSQL', async () => {
  const start = '2026-12-02T10:00:00+09:00';
  for (const [input, constraint] of [
    [{ customer: customerB }, 'appointment_m1_customer_fk'],
    [{ menu: menuB }, 'appointment_m1_menu_fk'],
    [{ staff: staffB }, 'appointment_m1_staff_fk'],
  ]) {
    await assert.rejects(add({ start, ...input }), { code: '23503', constraint });
  }
  const own = await add({ start });
  const visible = await db.withShop(shopB, (client) => client.query('SELECT id FROM crm.appointment_m1 WHERE id = $1', [own.id]));
  assert.equal(visible.rowCount, 0);
});

test('concurrent overlaps, status release, and a stale version predicate', async () => {
  const start = '2026-12-03T10:00:00+09:00';
  const results = await Promise.allSettled([add({ start }), add({ start })]);
  const [saved] = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.code, '23P01');
  const id = saved.value.id;
  const patch = (version) => db.withShop(shopA, (client) => client.query(
    "UPDATE crm.appointment_m1 SET status = 'cancelled' WHERE id = $1 AND version = $2 RETURNING version",
    [id, version],
  ));
  assert.deepEqual((await patch(1)).rows, [{ version: 2 }]);
  assert.equal((await patch(1)).rowCount, 0);
  assert.ok(await add({ start, status: 'no_show' }));
  assert.ok(await add({ start, status: 'voided' }));
  await assert.rejects(add({ start }), { code: '23P01' });
});
