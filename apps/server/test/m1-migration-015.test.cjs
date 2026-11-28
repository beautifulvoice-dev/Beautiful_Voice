// 015(S3 캘린더 rev.3.1) 데이터 이전 — 014까지 올린 빈 임시 DB에 합성 데이터를 넣고 015를 한 트랜잭션으로 적용한다.
// 마이그레이션 계정이 DB를 만들 수 있어야 한다(로컬·CI의 Compose DB 계정).
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFile, readdir } = require('node:fs/promises');
const { join } = require('node:path');
const { test, before, after } = require('node:test');
const { Client } = require('pg');

const dir = join(__dirname, '..', 'db', 'migrations');
const admin = new Client({ connectionString: process.env.DATABASE_MIGRATION_URL });
const created = [];
const [shop, customer, menu, emptyMenu, staff, withMenu, cancelled] = Array.from({ length: 7 }, () => randomUUID());

before(async () => {
  assert.ok(process.env.DATABASE_MIGRATION_URL);
  await admin.connect();
});

after(async () => {
  for (const { client, name } of created) {
    await client.end().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
  }
  await admin.end();
});

/** 014까지 적용한 새 DB. 015는 각 테스트가 apply015로 적용한다. */
async function databaseAt014() {
  const name = `bv_mig015_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(process.env.DATABASE_MIGRATION_URL);
  url.pathname = `/${name}`;
  const client = new Client({ connectionString: url.toString() });
  await client.connect();
  created.push({ client, name });
  await client.query('CREATE SCHEMA IF NOT EXISTS crm');
  for (const file of (await readdir(dir)).filter((f) => f.endsWith('.sql') && f < '015').sort()) {
    await client.query(await readFile(join(dir, file), 'utf8'));
  }
  await client.query("INSERT INTO crm.shop (id, name) VALUES ($1, 'Synthetic shop')", [shop]);
  await client.query("INSERT INTO crm.customer (id, shop_id, name, created_source) VALUES ($1, $2, 'Synthetic customer', 'manual')", [customer, shop]);
  await client.query("INSERT INTO crm.staff (id, shop_id, name) VALUES ($1, $2, 'Synthetic staff')", [staff, shop]);
  await client.query(`INSERT INTO crm.menu (id, shop_id, name, default_duration_min, default_prep_min)
    VALUES ($1, $3, 'Synthetic menu', 60, 20), ($2, $3, 'Synthetic empty menu', NULL, NULL)`, [menu, emptyMenu, shop]);
  return client;
}

async function apply015(client) {
  await client.query('BEGIN');
  try {
    await client.query(await readFile(join(dir, '015-s3-calendar-rev31.sql'), 'utf8'));
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

const historyCount = async (client) => Number((await client.query('SELECT count(*) FROM crm.appointment_m1_event')).rows[0].count);

test('이전: 분 값·시작·시술·version·수정 시각 보존, 점유만 새 식, 이력 행은 새로 생기지 않는다', async () => {
  const client = await databaseAt014();
  await client.query(`INSERT INTO crm.appointment_m1 (id, shop_id, customer_id, menu_id, staff_id, start_at, duration_min, prep_min, status)
    VALUES ($1, $3, $4, $5, $6, '2026-12-01T05:00:00Z', 60, 20, 'scheduled'),
           ($2, $3, $4, NULL, $6, '2026-12-01T07:00:00Z', 30, 0, 'cancelled')`, [withMenu, cancelled, shop, customer, menu, staff]);
  await client.query("UPDATE crm.appointment_m1 SET memo = 'synthetic memo' WHERE id = $1", [withMenu]); // version 2
  const snapshot = 'SELECT id, start_at, duration_min, version, updated_at FROM crm.appointment_m1 ORDER BY id';
  const beforeRows = (await client.query(snapshot)).rows;
  const beforeHistory = await historyCount(client);

  await apply015(client);

  assert.deepEqual((await client.query(snapshot)).rows, beforeRows, '시작·시술·version·updated_at 그대로');
  assert.equal(await historyCount(client), beforeHistory, '이전으로 "수정됨" 이력이 생기지 않는다');
  const { rows } = await client.query(`SELECT id, cleanup_min, menu_name_snapshot, version,
      lower(occupied) AS starts, upper(occupied) AS ends FROM crm.appointment_m1 WHERE id IN ($1, $2)`, [withMenu, cancelled]);
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.deepEqual([byId[withMenu].cleanup_min, byId[withMenu].menu_name_snapshot, byId[withMenu].version], [20, 'Synthetic menu', 2]);
  assert.deepEqual([byId[withMenu].starts.toISOString(), byId[withMenu].ends.toISOString()], ['2026-12-01T05:00:00.000Z', '2026-12-01T06:20:00.000Z']);
  assert.equal(byId[cancelled].menu_name_snapshot, null, '메뉴 없는 예약의 스냅샷은 NULL');

  const menus = (await client.query('SELECT id, default_duration_min, default_cleanup_min, default_price FROM crm.menu ORDER BY name')).rows;
  assert.deepEqual(menus.map((m) => [m.default_duration_min, m.default_cleanup_min, m.default_price]), [[null, null, 0], [60, 20, 0]],
    '기본 시간 NULL 유지, 가격 0');
  assert.equal((await client.query('SELECT require_staff_selection FROM crm.shop_settings WHERE shop_id = $1', [shop])).rows[0].require_staff_selection, false);

  const triggers = (await client.query(`SELECT tgname, tgenabled FROM pg_trigger
    WHERE tgrelid = 'crm.appointment_m1'::regclass AND NOT tgisinternal ORDER BY tgname`)).rows;
  assert.deepEqual(triggers, [{ tgname: 'appointment_m1_derive', tgenabled: 'O' }, { tgname: 'appointment_m1_record_event', tgenabled: 'O' }]);
  const forced = (await client.query(`SELECT relname FROM pg_class WHERE oid IN ('crm.menu'::regclass, 'crm.appointment_m1'::regclass)
    AND relforcerowsecurity ORDER BY relname`)).rows.map((r) => r.relname);
  assert.deepEqual(forced, ['appointment_m1', 'menu'], '강제 RLS를 다시 켠다');

  // 이전 뒤 일반 수정은 트리거가 다시 version·이력을 남긴다.
  const { rows: [next] } = await client.query(
    'UPDATE crm.appointment_m1 SET cleanup_min = 30 WHERE id = $1 RETURNING version, upper(occupied) AS ends', [withMenu]);
  assert.deepEqual([next.version, next.ends.toISOString()], [3, '2026-12-01T06:30:00.000Z']);
  assert.equal(await historyCount(client), beforeHistory + 1);
  const { rows: [event] } = await client.query('SELECT after_change FROM crm.appointment_m1_event WHERE appointment_id = $1 AND version = 3', [withMenu]);
  assert.equal(event.after_change.cleanup_min, 30, '새 이력은 cleanup_min 키');
});

test('범위 밖 메뉴·예약이 있으면 개수를 알리고 전체가 실패, 정정 뒤 다시 실행하면 성공', async () => {
  const client = await databaseAt014();
  await client.query('UPDATE crm.menu SET default_duration_min = 601 WHERE id = $1', [menu]);
  await client.query(`INSERT INTO crm.appointment_m1 (id, shop_id, customer_id, staff_id, start_at, duration_min, prep_min)
    VALUES ($1, $2, $3, $4, '2026-12-01T05:00:00Z', 60, 181), ($5, $2, $3, $4, '2026-12-02T05:00:00Z', 4, 0)`,
  [withMenu, shop, customer, staff, cancelled]);

  await assert.rejects(apply015(client), (error) => error.code === '23514' && /1 menu rows, 2 appointment rows/.test(error.message));
  const columns = (await client.query(`SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'crm' AND table_name = 'appointment_m1' AND column_name IN ('prep_min', 'cleanup_min')`)).rows;
  assert.deepEqual(columns, [{ column_name: 'prep_min' }], '실패하면 아무것도 바뀌지 않는다');

  await client.query('UPDATE crm.menu SET default_duration_min = 600 WHERE id = $1', [menu]);
  await client.query('UPDATE crm.appointment_m1 SET prep_min = 180, duration_min = greatest(duration_min, 5)');
  await apply015(client);
  const { rows } = await client.query('SELECT cleanup_min FROM crm.appointment_m1 ORDER BY start_at');
  assert.deepEqual(rows.map((r) => r.cleanup_min), [180, 180]);
});
