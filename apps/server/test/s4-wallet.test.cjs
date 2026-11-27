// S4 지갑 ①(설계 13 §2-3·§6·§9의 DB·공통 함수) — 실제 PostgreSQL로 확인한다. 합성 데이터만(절대 규칙 8).
// HTTP API는 다음 PR(S1 세션 가드 뒤)이라 여기서는 공통 지갑 함수를 매장 트랜잭션(withShop)에서 직접 부른다.
require('reflect-metadata');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { test, before, after } = require('node:test');
const { Client } = require('pg');
const { DatabaseService } = require('../dist/database.service.js');
const { WalletService } = require('../dist/wallet/wallet.service.js');

const admin = new Client({ connectionString: process.env.DATABASE_MIGRATION_URL });
const db = new DatabaseService();
const wallet = new WalletService();
const [shopA, shopB, customerA, customerA2, customerB, menuA, menuB, staffA] = Array.from({ length: 8 }, () => randomUUID());
const prepaid = { unitType: 'amount' };
const sessionsOf = (passId) => ({ unitType: 'sessions', passId });
const inA = (run) => db.withShop(shopA, run);

before(async () => {
  await admin.connect();
  await admin.query("INSERT INTO crm.shop (id, name) VALUES ($1, 'Synthetic WA'), ($2, 'Synthetic WB')", [shopA, shopB]);
  await admin.query(`INSERT INTO crm.customer (id, shop_id, name, created_source) VALUES
    ($1, $4, '합성 고객', 'manual'), ($2, $4, '합성 고객 둘', 'manual'), ($3, $5, '합성 B', 'manual')`, [customerA, customerA2, customerB, shopA, shopB]);
  await admin.query("INSERT INTO crm.menu (id, shop_id, name) VALUES ($1, $3, '합성 윤곽관리'), ($2, $4, '합성 B 메뉴')", [menuA, menuB, shopA, shopB]);
  await admin.query("INSERT INTO crm.staff (id, shop_id, name) VALUES ($1, $2, 'SA')", [staffA, shopA]);
  await db.onModuleInit();
});

after(async () => {
  await db.onModuleDestroy();
  try {
    for (const table of ['wallet_entry', 'customer_pass', 'appointment_m1', 'staff', 'menu', 'customer', 'shop_settings']) {
      await admin.query(`DELETE FROM crm.${table} WHERE shop_id IN ($1, $2)`, [shopA, shopB]);
    }
    await admin.query('DELETE FROM crm.shop WHERE id IN ($1, $2)', [shopA, shopB]);
  } finally {
    await admin.end();
  }
});

const issue = (customerId, extra = {}) => inA((c) => wallet.issuePassFromWeb(c, shopA, {
  customerId, name: '합성 10회권', menuId: menuA, sessions: 10, ...extra,
}));
const manual = (body) => inA((c) => wallet.recordManual(c, shopA, body));
const balance = (customerId, item) => inA((c) => wallet.balance(c, shopA, customerId, item));
const invalidField = (field, code) => (e) => e.code === 'VALIDATION_FAILED' && e.status === 422
  && e.details.fields.some((f) => f.field === field && f.code === code);

let appointmentDay = 0;
async function appointmentFor(customerId) {
  const id = randomUUID();
  appointmentDay += 1;
  await admin.query(`INSERT INTO crm.appointment_m1 (id, shop_id, customer_id, staff_id, start_at, duration_min)
    VALUES ($1, $2, $3, $4, now() + make_interval(days => $5), 60)`, [id, shopA, customerId, staffA, appointmentDay]);
  return id;
}

test('합계: 선불금과 두 횟수권이 따로 합산되고, 거래가 없으면 0, 음수 허용, 삭제 표시 행은 빠진다', async () => {
  const customer = randomUUID();
  await admin.query("INSERT INTO crm.customer (id, shop_id, name, created_source) VALUES ($1, $2, '합성 합계', 'manual')", [customer, shopA]);
  assert.equal(await balance(customer, prepaid), 0);
  const first = await issue(customer);
  const second = await issue(customer, { sessions: 5 });
  assert.equal(first.remainingSessions, 10);

  const pay = await manual({ customerId: customer, unitType: 'amount', label: 'payment', value: 50000 });
  assert.deepEqual([pay.signedDelta, pay.balanceAfter, pay.passId, pay.version], [50000, 50000, null, 1]);
  const over = await manual({ customerId: customer, unitType: 'amount', label: 'deduct', value: 70000, memo: '합성 메모' });
  assert.deepEqual([over.signedDelta, over.balanceAfter, over.memo], [-70000, -20000, '합성 메모']);
  for (let i = 0; i < 11; i += 1) await manual({ customerId: customer, unitType: 'sessions', passId: first.id, label: 'deduct', value: 1 });

  assert.equal(await balance(customer, prepaid), -20000);
  assert.equal(await balance(customer, sessionsOf(first.id)), -1);
  assert.equal(await balance(customer, sessionsOf(second.id)), 5);
  await admin.query('UPDATE crm.wallet_entry SET deleted_at = now() WHERE id = $1', [over.id]);
  assert.equal(await balance(customer, prepaid), 50000);
});

test('웹 기록: 0·소수·opening_balance·signedDelta·예약 지정은 검증 오류', async () => {
  const base = { customerId: customerA, unitType: 'amount', label: 'payment', value: 1000 };
  await assert.rejects(manual({ ...base, value: 0 }), invalidField('value', 'INVALID_VALUE'));
  await assert.rejects(manual({ ...base, value: 0.5 }), invalidField('value', 'INVALID_VALUE'));
  await assert.rejects(manual({ ...base, label: 'opening_balance' }), invalidField('label', 'INVALID_VALUE'));
  await assert.rejects(manual({ ...base, signedDelta: 1000 }), invalidField('signedDelta', 'UNKNOWN_FIELD'));
  await assert.rejects(manual({ ...base, appointmentId: randomUUID(), cycleSeq: 1 }), invalidField('appointmentId', 'UNKNOWN_FIELD'));
});

test('소유권: 같은 매장 다른 고객의 횟수권, 다른 매장 고객·메뉴는 서버(422)와 DB(FK·RLS)가 막는다', async () => {
  const pass = await issue(customerA);
  await assert.rejects(manual({ customerId: customerA2, unitType: 'sessions', passId: pass.id, label: 'deduct', value: 1 }),
    invalidField('passId', 'NOT_FOUND'));
  await assert.rejects(manual({ customerId: customerB, unitType: 'amount', label: 'payment', value: 1 }), invalidField('customerId', 'NOT_FOUND'));
  await assert.rejects(issue(customerA, { menuId: menuB }), invalidField('menuId', 'NOT_FOUND'));

  await assert.rejects(inA((c) => c.query(`INSERT INTO crm.wallet_entry (shop_id, customer_id, unit_type, pass_id, label, signed_delta)
    VALUES ($1, $2, 'sessions', $3, 'deduct', -1)`, [shopA, customerA2, pass.id])), (e) => e.constraint === 'wallet_entry_pass_fk');
  await assert.rejects(inA((c) => c.query(`INSERT INTO crm.customer_pass (shop_id, customer_id, name, menu_id, menu_name_snapshot)
    VALUES ($1, $2, 'x', $3, 'x')`, [shopA, customerA, menuB])), (e) => e.constraint === 'customer_pass_menu_fk');
  await assert.rejects(db.withShop(shopB, (c) => c.query(`INSERT INTO crm.wallet_entry (shop_id, customer_id, unit_type, label, signed_delta)
    VALUES ($1, $2, 'amount', 'payment', 1)`, [shopA, customerA])), { code: '42501' });
  assert.equal((await db.withShop(shopB, (c) => c.query('SELECT 1 FROM crm.customer_pass WHERE id = $1', [pass.id]))).rowCount, 0);
});

test('발급: 횟수권과 첫 결제가 함께 생기거나 함께 되돌아가고, 메뉴 이름 스냅샷은 이후 변경에 영향 없음, 선불금 그대로', async () => {
  const before = await balance(customerA, prepaid);
  let issuedId;
  await assert.rejects(inA(async (c) => {
    issuedId = (await wallet.issuePassFromWeb(c, shopA, { customerId: customerA, name: '합성 롤백권', menuId: menuA, sessions: 3 })).id;
    throw new Error('호출자 트랜잭션 실패');
  }), /호출자 트랜잭션 실패/);
  assert.equal((await admin.query('SELECT 1 FROM crm.customer_pass WHERE id = $1', [issuedId])).rowCount, 0);
  assert.equal((await admin.query('SELECT 1 FROM crm.wallet_entry WHERE pass_id = $1', [issuedId])).rowCount, 0);

  const pass = await issue(customerA, { name: '  합성   스냅샷권 ' });
  assert.equal(pass.name, '합성 스냅샷권');
  const { rows: entries } = await admin.query('SELECT label, signed_delta, unit_type FROM crm.wallet_entry WHERE pass_id = $1', [pass.id]);
  assert.deepEqual(entries, [{ label: 'payment', signed_delta: 10, unit_type: 'sessions' }]);
  await inA((c) => c.query("UPDATE crm.menu SET name = '합성 바뀐 메뉴' WHERE shop_id = $1 AND id = $2", [shopA, menuA]));
  const { rows: [snap] } = await admin.query('SELECT menu_name_snapshot FROM crm.customer_pass WHERE id = $1', [pass.id]);
  assert.equal(snap.menu_name_snapshot, '합성 윤곽관리');
  assert.equal(await balance(customerA, prepaid), before);
});

test('대표 횟수권: 새 대표를 고르면 기존 대표가 내려가고, DB는 활성 대표 둘을 거부, 숨긴 대표는 세지 않는다', async () => {
  const customer = randomUUID();
  await admin.query("INSERT INTO crm.customer (id, shop_id, name, created_source) VALUES ($1, $2, '합성 대표', 'manual')", [customer, shopA]);
  const first = await issue(customer, { isPrimary: true });
  const second = await issue(customer, { isPrimary: true });
  const plain = await issue(customer);
  const { rows } = await admin.query('SELECT id, is_primary, version FROM crm.customer_pass WHERE customer_id = $1 ORDER BY created_at', [customer]);
  assert.deepEqual(rows.map((r) => [r.id, r.is_primary]), [[first.id, false], [second.id, true], [plain.id, false]]);
  assert.equal(rows[0].version, 2, '자동 해제도 version을 올린다');

  await assert.rejects(inA((c) => c.query('UPDATE crm.customer_pass SET is_primary = true WHERE shop_id = $1 AND id = $2', [shopA, first.id])),
    (e) => e.code === '23505' && e.constraint === 'customer_pass_one_primary');
  await admin.query('UPDATE crm.customer_pass SET is_active = false WHERE id = $1', [second.id]);
  await inA((c) => c.query('UPDATE crm.customer_pass SET is_primary = true WHERE shop_id = $1 AND id = $2', [shopA, first.id]));
});

test('S6 차감: 예약·회차당 한 번, 새 회차는 허용, 차감 후 확정 잔액을 돌려준다, 다른 고객 예약은 거부', async () => {
  const pass = await issue(customerA2);
  const appointment = await appointmentFor(customerA2);
  const deduct = (cycleSeq, item = sessionsOf(pass.id)) => inA((c) => wallet.deductForCompletion(c, shopA, {
    customerId: customerA2, appointmentId: appointment, cycleSeq, item, value: 1,
  }));
  const done = await deduct(1);
  assert.deepEqual([done.label, done.signedDelta, done.balanceAfter, done.appointmentId, done.cycleSeq], ['deduct', -1, 9, appointment, 1]);
  await assert.rejects(deduct(1), { status: 409, code: 'COMPLETION_ALREADY_DEDUCTED' });
  await assert.rejects(deduct(1, prepaid), { status: 409, code: 'COMPLETION_ALREADY_DEDUCTED' });
  assert.equal((await deduct(2)).balanceAfter, 8);

  await assert.rejects(inA((c) => c.query(`INSERT INTO crm.wallet_entry (shop_id, customer_id, unit_type, pass_id, label, signed_delta, appointment_id, cycle_seq)
    VALUES ($1, $2, 'sessions', $3, 'deduct', -1, $4, 2)`, [shopA, customerA2, pass.id, appointment])),
  (e) => e.code === '23505' && e.constraint === 'wallet_entry_one_deduct_per_cycle');
  const other = await appointmentFor(customerA);
  await assert.rejects(inA((c) => wallet.deductForCompletion(c, shopA, {
    customerId: customerA2, appointmentId: other, cycleSeq: 1, item: prepaid, value: 1,
  })), invalidField('appointmentId', 'NOT_FOUND'));
});

test('DB CHECK: 단위·횟수권 짝, 종류별 부호, 예약·회차 짝이 틀린 행은 거부', async () => {
  const pass = await issue(customerA);
  const appointment = await appointmentFor(customerA);
  const insert = (unit, passId, label, delta, appointmentId = null, cycleSeq = null) => inA((c) => c.query(
    `INSERT INTO crm.wallet_entry (shop_id, customer_id, unit_type, pass_id, label, signed_delta, appointment_id, cycle_seq)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [shopA, customerA, unit, passId, label, delta, appointmentId, cycleSeq]));
  const violates = (constraint) => (e) => e.code === '23514' && e.constraint === constraint;
  await assert.rejects(insert('amount', pass.id, 'payment', 1), violates('wallet_entry_unit_pass'));
  await assert.rejects(insert('sessions', null, 'payment', 1), violates('wallet_entry_unit_pass'));
  for (const [label, delta] of [['payment', -1], ['refund', -1], ['deduct_cancel', 0], ['deduct', 1], ['payment_cancel', 1], ['opening_balance', 0]]) {
    await assert.rejects(insert('amount', null, label, delta), violates('wallet_entry_label_sign'), `${label} ${delta}`);
  }
  await assert.rejects(insert('amount', null, 'deduct', -1, appointment, null), violates('wallet_entry_appointment_cycle'));
  await assert.rejects(insert('amount', null, 'deduct', -1, null, 1), violates('wallet_entry_appointment_cycle'));
  await insert('amount', null, 'refund', 1);
  await insert('amount', null, 'payment_cancel', -1);
});

test('version 트리거와 역할: UPDATE마다 version·수정 시각이 오르고, 앱은 원장을 고치거나 지울 수 없고, AI 실행기는 읽기만', async () => {
  const entry = await manual({ customerId: customerA, unitType: 'amount', label: 'payment', value: 100 });
  const { rows: [bumped] } = await admin.query(
    "UPDATE crm.wallet_entry SET memo = '합성 수정' WHERE id = $1 RETURNING version, updated_at > created_at AS touched", [entry.id]);
  assert.deepEqual([bumped.version, bumped.touched], [2, true]);

  for (const [role, sql, visible] of [
    ['bv_app', "UPDATE crm.wallet_entry SET signed_delta = 1 WHERE id = $1", 1],
    ['bv_app', 'DELETE FROM crm.wallet_entry WHERE id = $1', 1],
    ['bv_app', 'UPDATE crm.customer_pass SET version = 9 WHERE id = $1', 1],
    ['bv_ai_executor', "UPDATE crm.wallet_entry SET memo = 'x' WHERE id = $1", 1],
    ['bv_ai_executor', `INSERT INTO crm.wallet_entry (shop_id, customer_id, unit_type, label, signed_delta)
      SELECT shop_id, customer_id, 'amount', 'payment', 1 FROM crm.wallet_entry WHERE id = $1`, 1],
    ['bv_ai_executor', 'UPDATE crm.customer_pass SET is_primary = false WHERE id = $1', 1],
  ]) {
    await admin.query('BEGIN');
    try {
      await admin.query(`SET LOCAL ROLE ${role}`);
      await admin.query("SELECT set_config('app.shop_id', $1, true)", [shopA]);
      assert.equal((await admin.query('SELECT 1 FROM crm.wallet_entry WHERE id = $1', [entry.id])).rowCount, visible, role);
      await assert.rejects(admin.query(sql, [entry.id]), { code: '42501' }, `${role}: ${sql}`);
    } finally {
      await admin.query('ROLLBACK');
    }
  }
  await admin.query('BEGIN');
  await admin.query('SET LOCAL ROLE bv_ai_executor');
  await admin.query("SELECT set_config('app.shop_id', $1, true)", [shopB]);
  assert.equal((await admin.query('SELECT 1 FROM crm.wallet_entry WHERE id = $1', [entry.id])).rowCount, 0, 'AI는 배정 매장만 본다');
  await admin.query('ROLLBACK');
});

test('CSV 이관: 0은 거래를 만들지 않고, 음수 초기값은 그대로 남는다', async () => {
  const customer = randomUUID();
  await admin.query("INSERT INTO crm.customer (id, shop_id, name, created_source) VALUES ($1, $2, '합성 이관', 'manual')", [customer, shopA]);
  const pass = await inA((c) => wallet.issuePass(c, shopA, { customerId: customer, name: '합성 장부권', menuId: null, sessions: 4, isPrimary: false }));
  assert.equal(pass.menuName, null);
  assert.equal(await inA((c) => wallet.recordOpeningBalance(c, shopA, { customerId: customer, item: prepaid, value: 0 })), null);
  assert.equal((await admin.query('SELECT 1 FROM crm.wallet_entry WHERE customer_id = $1 AND unit_type = $2', [customer, 'amount'])).rowCount, 0);
  const negative = await inA((c) => wallet.recordOpeningBalance(c, shopA, { customerId: customer, item: prepaid, value: -30000 }));
  assert.deepEqual([negative.label, negative.signedDelta, negative.balanceAfter], ['opening_balance', -30000, -30000]);
  const sessions = await inA((c) => wallet.recordOpeningBalance(c, shopA, { customerId: customer, item: sessionsOf(pass.id), value: -2 }));
  assert.equal(sessions.balanceAfter, 2);
  await assert.rejects(inA((c) => wallet.recordOpeningBalance(c, shopA, { customerId: customer, item: prepaid, value: 1.5 })),
    invalidField('value', 'INVALID_VALUE'));
});

test('동시 기록: 같은 매장의 쓰기는 매장 잠금으로 줄을 서서 각자 직전까지의 확정 잔액을 받는다', async () => {
  const customer = randomUUID();
  await admin.query("INSERT INTO crm.customer (id, shop_id, name, created_source) VALUES ($1, $2, '합성 동시', 'manual')", [customer, shopA]);
  const results = await Promise.all(Array.from({ length: 8 }, () =>
    manual({ customerId: customer, unitType: 'amount', label: 'payment', value: 1000 })));
  assert.deepEqual(results.map((r) => r.balanceAfter).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8].map((n) => n * 1000));
  assert.equal(await balance(customer, prepaid), 8000);
});
