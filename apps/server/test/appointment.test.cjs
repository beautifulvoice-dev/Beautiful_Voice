// C-07 세션 저장 서비스 — 실제 PostgreSQL(db:test). 합성 매장·시간만 쓴다.
// 시각은 서울(+09:00)로 적고 UTC로 저장된다. ctx.now를 고정해 상태(확정/완료) 계산이 날짜에 흔들리지 않게 한다.
require('reflect-metadata');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { test, before, after } = require('node:test');
const { Client } = require('pg');
const { DatabaseService } = require('../dist/database.service.js');
const { ApiError } = require('../dist/common/api-error.js');
const { requestFingerprint } = require('../dist/common/idempotency.js');
const { AppointmentService } = require('../dist/appointments/appointment.service.js');

const admin = new Client({ connectionString: process.env.DATABASE_MIGRATION_URL });
const db = new DatabaseService();
const service = new AppointmentService(db);
const shops = [];
const ctx = { actor: 'owner', source: 'web', now: new Date('2026-11-20T00:00:00+09:00') };
const at = (hhmm) => new Date(`2026-12-01T${hhmm}:00+09:00`);
const slot = (from, to, extra = {}) => ({ start: at(from), end: at(to), prepMinutes: 0, ...extra });

before(async () => {
  assert.ok(process.env.DATABASE_URL);
  assert.ok(process.env.DATABASE_MIGRATION_URL);
  await admin.connect();
  await db.onModuleInit();
});

after(async () => {
  await db.onModuleDestroy();
  for (const table of ['appointment_event', 'appointment', 'idempotency_key']) {
    await admin.query(`DELETE FROM crm.${table} WHERE shop_id = ANY($1)`, [shops]);
  }
  await admin.query('DELETE FROM crm.shop WHERE id = ANY($1)', [shops]);
  await admin.end();
});

async function newShop() {
  const id = randomUUID();
  shops.push(id);
  await admin.query('INSERT INTO crm.shop (id, name) VALUES ($1, $2)', [id, 'Synthetic shop']);
  return id;
}

const create = async (shop, input) => (await service.create(shop, input, ctx)).body;
const rejectsWith = (promise, status, code) =>
  assert.rejects(promise, (e) => e instanceof ApiError && e.status === status && e.code === code);
const lanes = async (shop) => Object.fromEntries((await admin.query(
  'SELECT id, lane FROM crm.appointment WHERE shop_id = $1', [shop])).rows.map((r) => [r.id, r.lane]));

test('등록: 원장이 만든 예약은 확정, 기본 준비 시간 10분, 이력 1건', async () => {
  const shop = await newShop();
  const created = await create(shop, { start: at('10:00'), end: at('11:00') });
  assert.deepEqual({ ...created, id: undefined }, {
    id: undefined, start: at('10:00').toISOString(), end: at('11:00').toISOString(),
    prepMinutes: 10, isForced: false, status: 'confirmed', version: 1,
  });
  const { rows } = await admin.query('SELECT type, to_status, actor, source FROM crm.appointment_event WHERE appointment_id = $1', [created.id]);
  assert.deepEqual(rows, [{ type: 'created', to_status: 'confirmed', actor: 'owner', source: 'web' }]);
});

test('AC-2: 겹치면 일반 저장은 409 APPOINTMENT_CONFLICT, 그대로 저장도 3건째는 409 CAPACITY_EXCEEDED', async () => {
  const shop = await newShop();
  const first = await create(shop, slot('10:00', '11:00'));
  await assert.rejects(service.create(shop, slot('10:00', '11:00'), ctx), (e) =>
    e.code === 'APPOINTMENT_CONFLICT' && e.status === 409 && e.details.conflictingIds[0] === first.id);
  const second = await create(shop, slot('10:00', '11:00', { force: true }));
  assert.equal(second.isForced, true);
  await rejectsWith(service.create(shop, slot('10:30', '11:30', { force: true }), ctx), 409, 'CAPACITY_EXCEEDED');
  assert.equal(Object.keys(await lanes(shop)).length, 2);
});

test('AC-3: 세션 뒤 준비 시간 10분 안에 넣으면 겹침, 준비 시간이 끝난 뒤는 허용', async () => {
  const shop = await newShop();
  await create(shop, { start: at('10:00'), end: at('11:00') });
  await rejectsWith(service.create(shop, slot('11:05', '12:00'), ctx), 409, 'APPOINTMENT_CONFLICT');
  assert.equal((await create(shop, slot('11:10', '12:00'))).status, 'confirmed');
});

test('그대로 저장: 필요하면 기존 예약의 자리를 같은 트랜잭션에서 다시 배정한다', async () => {
  const shop = await newShop();
  const x = await create(shop, slot('10:00', '11:00'));
  const z = await create(shop, slot('10:30', '11:30', { force: true }));
  const y = await create(shop, slot('11:40', '12:30'));
  assert.deepEqual(await lanes(shop), { [x.id]: 1, [z.id]: 2, [y.id]: 1 });
  const n = await create(shop, slot('11:00', '11:50', { force: true }));
  assert.deepEqual(await lanes(shop), { [x.id]: 1, [z.id]: 2, [n.id]: 1, [y.id]: 2 });
});

test('동시에 같은 시간 그대로 저장 10번 → 정확히 2건만 저장', async () => {
  const shop = await newShop();
  const results = await Promise.allSettled(Array.from({ length: 10 }, () =>
    service.create(shop, slot('15:00', '16:00', { force: true }), ctx)));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 2);
  for (const r of results.filter((r) => r.status === 'rejected')) assert.equal(r.reason.code, 'CAPACITY_EXCEEDED');
});

test('Idempotency-Key: 같은 등록을 다시 보내도 1건, 같은 응답', async () => {
  const shop = await newShop();
  const input = slot('13:00', '14:00');
  const idem = { key: randomUUID(), fingerprint: requestFingerprint('POST', '/api/appointments', { start: '13:00', end: '14:00' }) };
  const a = await service.create(shop, input, ctx, idem);
  const b = await service.create(shop, input, ctx, idem);
  assert.equal(b.replayed, true);
  assert.deepEqual(b.body, a.body);
  assert.equal(Object.keys(await lanes(shop)).length, 1);
});

test('시간 변경: 자기 자신과는 겹치지 않고, 남과 겹치면 거절되며 원래 값이 남는다', async () => {
  const shop = await newShop();
  const a = await create(shop, slot('10:00', '11:00'));
  await create(shop, slot('12:00', '13:00'));
  const moved = (await service.move(shop, a.id, slot('10:30', '11:30'), ctx)).body;
  assert.equal(moved.start, at('10:30').toISOString());
  assert.equal(moved.version, 2);
  await rejectsWith(service.move(shop, a.id, slot('12:30', '13:30'), ctx), 409, 'APPOINTMENT_CONFLICT');
  const { rows: [row] } = await admin.query('SELECT lower(period) AS s, version FROM crm.appointment WHERE id = $1', [a.id]);
  assert.deepEqual(row, { s: at('10:30'), version: 2 });
  const { rows: events } = await admin.query(
    "SELECT before->>'start' AS b, after->>'start' AS a FROM crm.appointment_event WHERE appointment_id = $1 AND type = 'moved'", [a.id]);
  assert.deepEqual(events, [{ b: at('10:00').toISOString(), a: at('10:30').toISOString() }]);
});

test('취소: 자리가 비고, 두 번 취소하면 409 INVALID_TRANSITION', async () => {
  const shop = await newShop();
  const a = await create(shop, slot('10:00', '11:00'));
  await create(shop, slot('10:00', '11:00', { force: true }));
  assert.equal((await service.cancel(shop, a.id, ctx)).body.status, 'canceled');
  assert.equal((await create(shop, slot('10:00', '11:00', { force: true }))).status, 'confirmed');
  await rejectsWith(service.cancel(shop, a.id, ctx), 409, 'INVALID_TRANSITION');
  await rejectsWith(service.move(shop, a.id, slot('16:00', '17:00'), ctx), 409, 'INVALID_TRANSITION');
});

test('검사(check)는 저장하지 않는다', async () => {
  const shop = await newShop();
  const a = await create(shop, slot('10:00', '11:00'));
  assert.deepEqual(await service.check(shop, slot('10:00', '11:00')),
    { ok: false, reason: 'APPOINTMENT_CONFLICT', conflictingIds: [a.id] });
  assert.deepEqual(await service.check(shop, slot('10:00', '11:00', { force: true })), { ok: true, isForced: true });
  assert.deepEqual(await service.check(shop, slot('11:00', '10:00')), { ok: false, reason: 'INVALID_PERIOD', conflictingIds: [] });
  assert.equal(Object.keys(await lanes(shop)).length, 1);
});

test('매장 격리: 다른 매장 예약은 판정에 들어가지 않고, 다른 매장 예약은 바꿀 수 없다(404)', async () => {
  const [shopA, shopB] = [await newShop(), await newShop()];
  const a = await create(shopA, slot('10:00', '11:00'));
  await create(shopA, slot('10:00', '11:00', { force: true }));
  assert.equal((await create(shopB, slot('10:00', '11:00'))).status, 'confirmed');
  await rejectsWith(service.cancel(shopB, a.id, ctx), 404, 'APPOINTMENT_NOT_FOUND');
  await rejectsWith(service.move(shopB, a.id, slot('16:00', '17:00'), ctx), 404, 'APPOINTMENT_NOT_FOUND');
});

test('잘못된 시간(끝이 시작보다 앞)은 400 INVALID_PERIOD', async () => {
  const shop = await newShop();
  await rejectsWith(service.create(shop, slot('11:00', '10:00'), ctx), 400, 'INVALID_PERIOD');
});
