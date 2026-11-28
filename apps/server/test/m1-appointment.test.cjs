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

function add({ start, staff = staffA, customer = customerA, menu = menuA, cleanup = 20, duration = 60, status = 'scheduled' }) {
  return db.withShop(shopA, async (client) => {
    const { rows: [row] } = await client.query(
      `INSERT INTO crm.appointment_m1
         (shop_id, customer_id, menu_id, staff_id, start_at, duration_min, cleanup_min, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, version, lower(occupied) AS starts, upper(occupied) AS ends`,
      [shopA, customer, menu, staff, start, duration, cleanup, status],
    );
    return row;
  });
}

// 015: 점유는 [시작, 시작 + 시술 + 정리), 겹침 배타 제약은 없다 — 겹침은 서버가 매장 쓰기 잠금 안에서 경고로 판정한다.
test('treatment starts at 14:00, with cleanup occupying 14:00 to 15:20; overlapping rows are stored', async () => {
  const first = await add({ start: '2026-12-01T14:00:00+09:00' });
  assert.equal(first.starts.toISOString(), '2026-12-01T05:00:00.000Z');
  assert.equal(first.ends.toISOString(), '2026-12-01T06:20:00.000Z');
  assert.ok(await add({ start: '2026-12-01T15:10:00+09:00', duration: 5, cleanup: 0 }), 'same staff overlap is no longer a DB error');
  const unassigned = await add({ start: '2026-12-01T14:00:00+09:00', staff: null, menu: null });
  assert.equal(unassigned.ends.toISOString(), '2026-12-01T06:20:00.000Z', 'staff_id NULL means unassigned');
});

test('time ranges are checked by PostgreSQL: treatment 5~600, cleanup 0~180', async () => {
  const start = '2026-12-04T10:00:00+09:00';
  for (const input of [{ duration: 4 }, { duration: 601 }, { cleanup: -1 }, { cleanup: 181 }]) {
    await assert.rejects(add({ start, ...input }), { code: '23514' });
  }
  assert.ok(await add({ start, duration: 5, cleanup: 0 }));
  assert.ok(await add({ start, duration: 600, cleanup: 180 }));
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

test('concurrent same-slot rows are both stored, and a stale version predicate matches nothing', async () => {
  const start = '2026-12-03T10:00:00+09:00';
  const [saved, other] = await Promise.all([add({ start }), add({ start })]);
  assert.notEqual(saved.id, other.id);
  const patch = (version) => db.withShop(shopA, (client) => client.query(
    "UPDATE crm.appointment_m1 SET status = 'cancelled' WHERE id = $1 AND version = $2 RETURNING version",
    [saved.id, version],
  ));
  assert.deepEqual((await patch(1)).rows, [{ version: 2 }]);
  assert.equal((await patch(1)).rowCount, 0);
});

test('the app role can write the new columns: menu price, menu name snapshot, staff selection rule', async () => {
  await db.withShop(shopA, async (client) => {
    const { rows: [menu] } = await client.query(
      'UPDATE crm.menu SET default_price = 50000, default_cleanup_min = 10 WHERE shop_id = $1 AND id = $2 RETURNING default_price', [shopA, menuA]);
    assert.equal(menu.default_price, 50000);
    const { rows: [appointment] } = await client.query(
      `INSERT INTO crm.appointment_m1 (shop_id, customer_id, menu_id, staff_id, start_at, duration_min, menu_name_snapshot)
       VALUES ($1, $2, $3, $4, '2026-12-05T01:00:00Z', 60, 'A') RETURNING id`, [shopA, customerA, menuA, staffA]);
    await client.query('UPDATE crm.appointment_m1 SET menu_name_snapshot = NULL WHERE shop_id = $1 AND id = $2', [shopA, appointment.id]);
    const { rows: [settings] } = await client.query(
      'UPDATE crm.shop_settings SET require_staff_selection = true WHERE shop_id = $1 RETURNING require_staff_selection', [shopA]);
    assert.equal(settings.require_staff_selection, true);
  });
  await assert.rejects(db.withShop(shopA, (client) =>
    client.query('UPDATE crm.menu SET default_price = -1 WHERE shop_id = $1 AND id = $2', [shopA, menuA])), { code: '23514' });
});
