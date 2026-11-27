// BEA-176 예약 등록·상세·변경 API — 실제 PostgreSQL + Nest 앱으로 계약 #42의 appointments 동작을 확인한다.
// 수용 기준(설계 04): 같은 담당자 겹침 거부·다른 담당자 허용 / 영업시간·휴무(관리 구간만) / 매장 간 참조 거부 /
// 중복 전송 / 동시 저장(DB 제약이 최종 판정) / 오래된 version / 변경 때 D2 재검사 범위. 합성 데이터만 쓴다(절대 규칙 8).
require('reflect-metadata');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { test, before, after } = require('node:test');
const { Module } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const { Client } = require('pg');
const { DatabaseService } = require('../dist/database.service.js');
const { ApiExceptionFilter } = require('../dist/common/api-exception.filter.js');
const { AppointmentM1Controller } = require('../dist/appointments-m1/appointment-m1.controller.js');
const { AppointmentM1Service } = require('../dist/appointments-m1/appointment-m1.service.js');
const { signCookie } = require('../dist/owner-session.js');

const SECRET = 'ef'.repeat(32);
const env = {
  KAKAO_CLIENT_ID: 'test-app', KAKAO_CLIENT_SECRET: 'test-secret',
  KAKAO_REDIRECT_URI: 'https://example.test/api/auth/kakao/callback', BV_SESSION_SECRET: SECRET,
};
const savedEnv = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
const admin = new Client({ connectionString: process.env.DATABASE_MIGRATION_URL });
const [shopA, shopB, userA, userB, customerA, customerOff, customerB, staff1, staff2, staffOff, staffB, menuA, menuB] =
  Array.from({ length: 13 }, () => randomUUID());
let app;
let base;

before(async () => {
  Object.assign(process.env, env);
  await admin.connect();
  await admin.query("INSERT INTO crm.shop (id, name) VALUES ($1, 'Synthetic A'), ($2, 'Synthetic B')", [shopA, shopB]);
  await admin.query('INSERT INTO crm.user_membership (shop_id, user_id) VALUES ($1, $2), ($3, $4)', [shopA, userA, shopB, userB]);
  await admin.query(`INSERT INTO crm.customer (id, shop_id, name, created_source, active, deactivated_at) VALUES
    ($1, $4, '합성 고객', 'manual', true, NULL), ($2, $4, '합성 휴면', 'manual', false, now()), ($3, $5, '합성 B', 'manual', true, NULL)`,
  [customerA, customerOff, customerB, shopA, shopB]);
  await admin.query(`INSERT INTO crm.staff (id, shop_id, name, active) VALUES
    ($1, $5, 'S1', true), ($2, $5, 'S2', true), ($3, $5, 'S-off', false), ($4, $6, 'SB', true)`,
  [staff1, staff2, staffOff, staffB, shopA, shopB]);
  await admin.query("INSERT INTO crm.menu (id, shop_id, name) VALUES ($1, $3, '합성 관리'), ($2, $4, 'B 관리')", [menuA, menuB, shopA, shopB]);
  // 월~토 10:00~20:00(서울), 일요일은 키 없음 = 휴무. 12/25(금)는 공휴일 휴무.
  // 토요일만 휴게 없이 맞닿은 구간 + 실제 휴게(15:00~16:00) — 설정 API가 이렇게 저장한다(#55 리뷰).
  const week = Object.fromEntries([1, 2, 3, 4, 5].map((d) => [d, [{ open: '10:00', close: '20:00' }]]));
  week[6] = [{ open: '10:00', close: '13:00' }, { open: '13:00', close: '15:00' }, { open: '16:00', close: '20:00' }];
  await admin.query('UPDATE crm.shop_settings SET business_hours = $2 WHERE shop_id = $1', [shopA, JSON.stringify(week)]);
  await admin.query("INSERT INTO crm.shop_closure (shop_id, kind, start_date, end_date) VALUES ($1, 'holiday', '2026-12-25', '2026-12-25')", [shopA]);

  class TestModule {}
  Module({ controllers: [AppointmentM1Controller], providers: [DatabaseService, AppointmentM1Service] })(TestModule);
  app = await NestFactory.create(TestModule, { logger: false });
  app.useGlobalFilters(new ApiExceptionFilter());
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
});

after(async () => {
  await app?.close();
  try {
    for (const table of ['idempotency_key', 'appointment_m1_event', 'appointment_m1', 'staff', 'menu', 'customer', 'shop_closure', 'shop_settings', 'user_membership']) {
      await admin.query(`DELETE FROM crm.${table} WHERE shop_id IN ($1, $2)`, [shopA, shopB]);
    }
    await admin.query('DELETE FROM crm.shop WHERE id IN ($1, $2)', [shopA, shopB]);
  } finally {
    await admin.end();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

const cookieOf = (user, shop) => 'bv_session=' + signCookie(Buffer.from(SECRET, 'hex'), 'owner-session', `${user}:${shop}`, 600);
const ownerA = cookieOf(userA, shopA);
const ownerB = cookieOf(userB, shopB);
const A = `/api/shops/${shopA}/appointments`;

async function call(method, path, { cookie = ownerA, body, key = randomUUID() } = {}) {
  const headers = { Cookie: cookie };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (key && method !== 'GET') headers['Idempotency-Key'] = key;
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, replayed: res.headers.get('idempotent-replayed') };
}
// 서울 시각으로 적는다. 2026-12-01은 화요일.
const at = (day, hhmm) => `2026-12-${day}T${hhmm}:00+09:00`;
const book = (overrides) => call('POST', A, { body: { customerId: customerA, staffId: staff1, startAt: at('01', '10:00'), durationMin: 60, ...overrides } });
const patch = (id, body, opts = {}) => call('PATCH', `${A}/${id}`, { body, ...opts });

const warn = (res) => res.body.warnings.map((w) => [w.code, ...w.relatedIds]);

test('등록 201 → 상세 조회가 같은 값(UTC 저장, 정리 기본 0, 메뉴 이름 스냅샷, 경고·차단·겹침 빈 배열)', async () => {
  const created = await book({ startAt: at('02', '10:00'), menuId: menuA, memo: ' 첫 방문 ' });
  assert.equal(created.status, 201);
  const { id, version, createdAt, updatedAt, warnings, ...rest } = created.body;
  assert.equal(version, 1);
  assert.ok(id && createdAt && updatedAt);
  assert.deepEqual(warnings, []);
  assert.deepEqual(rest, {
    customerId: customerA, menuId: menuA, staffId: staff1, startAt: '2026-12-02T01:00:00.000Z', durationMin: 60, cleanupMin: 0, prepMin: 0,
    memo: '첫 방문', status: 'scheduled', customerName: '합성 고객', menuName: '합성 관리', blockedBy: [], overlappingAppointmentIds: [],
  });
  const view = { ...created.body };
  delete view.warnings;
  assert.deepEqual((await call('GET', `${A}/${id}`)).body, view, '조회는 warnings 없이 같은 예약');
  // 메뉴 이름이 바뀌어도 예약에는 저장할 때의 이름이 남는다(015 스냅샷).
  await admin.query("UPDATE crm.menu SET name = '합성 관리(새 이름)' WHERE id = $1", [menuA]);
  assert.equal((await call('GET', `${A}/${id}`)).body.menuName, '합성 관리');
  await admin.query("UPDATE crm.menu SET name = '합성 관리' WHERE id = $1", [menuA]);
  // 다른 매장 원장은 경로부터 404, 자기 매장 경로로 남의 예약 id를 물어도 404
  assert.equal((await call('GET', `${A}/${id}`, { cookie: ownerB })).status, 404);
  const foreign = await call('GET', `/api/shops/${shopB}/appointments/${id}`, { cookie: ownerB });
  assert.equal(foreign.status, 404);
  assert.equal(foreign.body.code, 'NOT_FOUND');
  assert.equal((await call('GET', `${A}/not-a-uuid`)).status, 404);
});

test('M1 API 등록·수정·상태 변경은 원자적으로 이력이 남고 앱은 직접 추가할 수 없다', async () => {
  const created = await book({ startAt: at('09', '10:00'), memo: '이전 메모' });
  assert.equal(created.status, 201);
  const { id } = created.body;
  const updated = await patch(id, { version: 1, memo: '수정한 메모' });
  assert.equal(updated.status, 200);
  const cancelled = await call('PUT', `${A}/${id}/status`, { body: { version: 2, status: 'cancelled' } });
  assert.equal(cancelled.status, 200);

  const appDb = new DatabaseService();
  try {
    await appDb.withShop(shopA, async (client) => {
      const { rows } = await client.query(
        `SELECT version, event_type, before_change->>'memo' AS old_memo, after_change->>'status' AS status
         FROM crm.appointment_m1_event WHERE appointment_id = $1 ORDER BY version`, [id],
      );
      assert.deepEqual(rows, [
        { version: 1, event_type: 'created', old_memo: null, status: 'scheduled' },
        { version: 2, event_type: 'updated', old_memo: '이전 메모', status: 'scheduled' },
        { version: 3, event_type: 'status_changed', old_memo: '수정한 메모', status: 'cancelled' },
      ]);
    });
    await appDb.withShop(shopB, async (client) => {
      assert.equal((await client.query('SELECT 1 FROM crm.appointment_m1_event WHERE appointment_id = $1', [id])).rowCount, 0);
    });
    await assert.rejects(appDb.withShop(shopA, (client) =>
      client.query('INSERT INTO crm.appointment_m1_event DEFAULT VALUES')), { code: '42501' });
  } finally {
    await appDb.onModuleDestroy();
  }
});

test('예약 겹침은 저장 + OVERLAP_APPOINTMENT: 같은 담당자·정리 시간 포함, 다른 담당자는 경고 없음, 맞닿으면 없음', async () => {
  const first = await book({ startAt: at('03', '11:00') });
  assert.deepEqual(warn(first), []);
  const clash = await book({ startAt: at('03', '10:00'), durationMin: 40, cleanupMin: 30 }); // 점유 ~11:10 → 11:00~12:00과 겹침
  assert.equal(clash.status, 201);
  assert.deepEqual(warn(clash), [['OVERLAP_APPOINTMENT', first.body.id]]);
  assert.deepEqual(clash.body.overlappingAppointmentIds, [first.body.id]);
  assert.deepEqual((await call('GET', `${A}/${first.body.id}`)).body.overlappingAppointmentIds, [clash.body.id], '상대 예약 상세에도 보인다');
  assert.deepEqual(warn(await book({ startAt: at('03', '11:00'), staffId: staff2 })), [], '다른 지정 담당자끼리는 경고 없음');
  const touching = await book({ startAt: at('03', '12:00'), durationMin: 30, cleanupMin: 10 });
  assert.deepEqual(warn(touching), [], '끝과 시작이 맞닿으면 겹침 아님');
});

test('담당자 미지정(생략·null)은 누구와도 겹친다, 옛 이름 prepMin도 정리 시간으로 받는다(S3 전환)', async () => {
  const unassigned = await call('POST', A, { body: { customerId: customerA, startAt: at('14', '10:00'), durationMin: 60, prepMin: 15 } });
  assert.equal(unassigned.status, 201);
  assert.deepEqual([unassigned.body.staffId, unassigned.body.cleanupMin, unassigned.body.prepMin], [null, 15, 15]);
  const s1 = await book({ startAt: at('14', '10:30') });
  const s2 = await book({ startAt: at('14', '11:00'), staffId: staff2 }); // 미지정 점유 ~11:15와 겹침
  assert.deepEqual(warn(s1), [['OVERLAP_APPOINTMENT', unassigned.body.id]]);
  assert.deepEqual(warn(s2), [['OVERLAP_APPOINTMENT', unassigned.body.id]], 's1과는 다른 담당자라 경고 없음');
  const both = await book({ startAt: at('14', '10:45'), staffId: null });
  assert.deepEqual(warn(both), [['OVERLAP_APPOINTMENT', unassigned.body.id, s1.body.id, s2.body.id]]);
  const dup = await call('POST', A, { body: { customerId: customerA, startAt: at('14', '15:00'), durationMin: 60, prepMin: 5, cleanupMin: 5 } });
  assert.deepEqual(dup.body.details.fields, [{ field: 'prepMin', code: 'DUPLICATE_FIELD' }]);
  // 수정: 생략은 그대로, null은 해제
  const kept = await patch(s1.body.id, { version: 1, memo: '담당자 그대로' });
  assert.equal(kept.body.staffId, staff1);
  const released = await patch(s1.body.id, { version: 2, staffId: null });
  assert.equal(released.body.staffId, null);
  assert.deepEqual(warn(released), [['OVERLAP_APPOINTMENT', unassigned.body.id, both.body.id, s2.body.id]]);
});

test('담당자 필수 설정: 새 예약·시간·담당자 변경에서 미지정이면 422 staffId REQUIRED, 기존 미지정 예약의 메모 수정은 허용', async () => {
  const old = await call('POST', A, { body: { customerId: customerA, startAt: at('15', '10:00'), durationMin: 60 } });
  await admin.query('UPDATE crm.shop_settings SET require_staff_selection = true WHERE shop_id = $1', [shopA]);
  try {
    const required = await call('POST', A, { body: { customerId: customerA, startAt: at('15', '12:00'), durationMin: 60 } });
    assert.equal(required.status, 422);
    assert.deepEqual(required.body, { code: 'VALIDATION_FAILED', message: '담당자를 선택해 주세요.', details: { fields: [{ field: 'staffId', code: 'REQUIRED' }] } });
    assert.equal((await patch(old.body.id, { version: 1, memo: '메모만' })).status, 200);
    assert.deepEqual((await patch(old.body.id, { version: 2, startAt: at('15', '11:00') })).body.details.fields, [{ field: 'staffId', code: 'REQUIRED' }]);
    const assigned = await book({ startAt: at('15', '14:00') });
    assert.deepEqual((await patch(assigned.body.id, { version: 1, staffId: null })).body.details.fields, [{ field: 'staffId', code: 'REQUIRED' }]);
    assert.equal((await patch(old.body.id, { version: 2, staffId: staff1, startAt: at('15', '11:00') })).status, 200, '담당자를 고르면 된다');
  } finally {
    await admin.query('UPDATE crm.shop_settings SET require_staff_selection = false WHERE shop_id = $1', [shopA]);
  }
});

test('영업시간 밖·휴무도 저장 + 경고(시술 구간 기준) — 정리만 마감 뒤로 넘어가면 경고 없음', async () => {
  const late = await book({ startAt: at('04', '19:30') });
  assert.deepEqual([late.status, ...warn(late)], [201, ['OUTSIDE_BUSINESS_HOURS']]);
  assert.deepEqual(warn(await book({ startAt: at('04', '09:30'), staffId: staff2 })), [['OUTSIDE_BUSINESS_HOURS']]);
  assert.deepEqual(warn(await book({ startAt: at('06', '12:00') })), [['CLOSED_DAY']], '일요일(영업시간 없음)');
  assert.deepEqual(warn(await book({ startAt: at('25', '12:00') })), [['CLOSED_DAY']], '공휴일 휴무');
  assert.deepEqual(warn(await book({ startAt: at('04', '12:00'), cleanupMin: 30 })), []);
  const cleanupAfterClose = await book({ startAt: at('04', '17:00'), durationMin: 180, cleanupMin: 30, staffId: staff2 });
  assert.deepEqual(warn(cleanupAfterClose), [], '20:00 마감에 시술이 끝나면 정리는 넘어가도 된다');
  // 겹침과 휴무가 동시에: 저장되고 둘 다 알린다
  const sunday = await book({ startAt: at('06', '12:30') });
  assert.deepEqual(warn(sunday).map((w) => w[0]), ['OVERLAP_APPOINTMENT', 'CLOSED_DAY']);
});

test('맞닿은 영업 구간에 걸친 시술은 경고 없음, 실제 휴게 공백에 걸치면 OUTSIDE_BUSINESS_HOURS(#55 리뷰)', async () => {
  assert.deepEqual(warn(await book({ startAt: at('12', '12:30') })), [], '13:00에 맞닿은 두 구간은 이어진 영업시간');
  const gap = await book({ startAt: at('12', '14:30'), staffId: staff2 });
  assert.deepEqual([gap.status, ...warn(gap)], [201, ['OUTSIDE_BUSINESS_HOURS']]);
});

test('다른 매장·비활성 참조와 형식 오류는 422 VALIDATION_FAILED(ASSUMPTION D3)', async () => {
  const foreign = await book({ customerId: customerB, staffId: staffB, menuId: menuB, startAt: at('05', '10:00') });
  assert.equal(foreign.status, 422);
  assert.deepEqual(foreign.body.details.fields, [
    { field: 'customerId', code: 'NOT_FOUND' }, { field: 'staffId', code: 'NOT_FOUND' }, { field: 'menuId', code: 'NOT_FOUND' }]);
  const inactive = await book({ customerId: customerOff, staffId: staffOff, startAt: at('05', '10:00') });
  assert.deepEqual(inactive.body.details.fields, [{ field: 'customerId', code: 'INACTIVE' }, { field: 'staffId', code: 'INACTIVE' }]);
  const bad = await call('POST', A, { body: { customerId: 'x', staffId: 1, startAt: '2026-12-05T10:00:00', durationMin: 4, cleanupMin: 181, status: 'completed' } });
  assert.equal(bad.status, 422);
  assert.deepEqual(bad.body.details.fields, [
    { field: 'status', code: 'UNKNOWN_FIELD' }, { field: 'customerId', code: 'INVALID_ID' }, { field: 'staffId', code: 'INVALID_ID' },
    { field: 'startAt', code: 'INVALID_DATETIME' }, { field: 'durationMin', code: 'INVALID_MINUTES' }, { field: 'cleanupMin', code: 'INVALID_MINUTES' }]);
  assert.equal((await book({ startAt: at('05', '10:00'), durationMin: 601 })).body.details.fields[0].code, 'INVALID_MINUTES');
  assert.equal((await book({ startAt: '2026-02-30T10:00:00+09:00' })).body.details.fields[0].code, 'INVALID_DATETIME');
  const { rows: [{ count }] } = await admin.query("SELECT count(*)::int FROM crm.appointment_m1 WHERE shop_id = $1 AND start_at::date = '2026-12-05'", [shopA]);
  assert.equal(count, 0);
});

test('같은 키·같은 요청은 같은 응답 재생, 같은 키·다른 요청은 422', async () => {
  const key = randomUUID();
  const body = { customerId: customerA, staffId: staff1, startAt: at('07', '10:00'), durationMin: 30 };
  const first = await call('POST', A, { body, key });
  const again = await call('POST', A, { body, key });
  assert.equal(again.status, 201);
  assert.equal(again.replayed, 'true');
  assert.deepEqual(again.body, first.body);
  const reused = await call('POST', A, { body: { ...body, durationMin: 45 }, key });
  assert.equal(reused.status, 422);
  assert.equal(reused.body.code, 'IDEMPOTENCY_KEY_REUSED');
  const { rows } = await admin.query("SELECT id FROM crm.appointment_m1 WHERE shop_id = $1 AND start_at = '2026-12-07T01:00:00Z'", [shopA]);
  assert.equal(rows.length, 1);
  assert.equal((await call('POST', A, { body, key: null })).body.code, 'INVALID_IDEMPOTENCY_KEY');
});

// 015에서 배타 제약을 없앴다 — 동시 저장은 매장 쓰기 잠금(lockShopWrites)이 줄 세우고, 뒤 요청은 먼저 커밋된 예약을 보고 판정한다.
test('동시 저장 8건: 모두 저장되고, 잠금 순서상 뒤 요청일수록 앞서 커밋된 예약을 경고로 받는다', async () => {
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) =>
    book({ startAt: at('09', '10:00'), durationMin: 60 + i })));
  assert.ok(results.every((r) => r.status === 201));
  const counts = results.map((r) => r.body.warnings[0]?.relatedIds.length ?? 0).sort();
  assert.deepEqual(counts, [0, 1, 2, 3, 4, 5, 6, 7], '각 요청은 자기보다 먼저 커밋된 예약을 모두 본다');
});

test('미리 보기: 저장과 같은 경고, 아무것도 쓰지 않는다, 수정은 현재 값에 합치고 자신은 뺀다, 오래된 version 409', async () => {
  const preview = (body, opts = {}) => call('POST', `${A}/preview-warnings`, { body, key: null, ...opts });
  const base = await book({ startAt: at('16', '10:00') });
  const draft = { customerId: customerA, staffId: staff1, startAt: at('16', '10:30'), durationMin: 60 };
  const before = (await admin.query('SELECT (SELECT count(*) FROM crm.appointment_m1 WHERE shop_id = $1)::int AS a, (SELECT count(*) FROM crm.idempotency_key WHERE shop_id = $1)::int AS k', [shopA])).rows[0];
  const shown = await preview(draft);
  assert.deepEqual([shown.status, shown.body], [200, { warnings: [{ code: 'OVERLAP_APPOINTMENT', relatedIds: [base.body.id] }] }]);
  const after = (await admin.query('SELECT (SELECT count(*) FROM crm.appointment_m1 WHERE shop_id = $1)::int AS a, (SELECT count(*) FROM crm.idempotency_key WHERE shop_id = $1)::int AS k', [shopA])).rows[0];
  assert.deepEqual(after, before, '예약·멱등 데이터를 쓰지 않는다');
  const savedNow = await call('POST', A, { body: draft });
  assert.deepEqual(savedNow.body.warnings, shown.body.warnings, '상태가 같으면 저장 결과도 같다');

  const edit = await preview({ appointmentId: base.body.id, version: 1, startAt: at('16', '11:00') });
  assert.deepEqual(edit.body, { warnings: [{ code: 'OVERLAP_APPOINTMENT', relatedIds: [savedNow.body.id] }] }, '자기 자신은 빼고 새 시간으로');
  assert.deepEqual((await preview({ appointmentId: base.body.id, version: 1, startAt: at('16', '19:30') })).body.warnings,
    [{ code: 'OUTSIDE_BUSINESS_HOURS', relatedIds: [] }]);
  const stale = await preview({ appointmentId: base.body.id, version: 9, memo: 'x' });
  assert.deepEqual([stale.status, stale.body.code, stale.body.details], [409, 'VERSION_CONFLICT', { currentVersion: 1 }]);
  const missing = await preview({ appointmentId: randomUUID(), version: 1 });
  assert.deepEqual([missing.status, missing.body.details.fields], [422, [{ field: 'appointmentId', code: 'NOT_FOUND' }]]);
  const otherShop = await preview({ ...draft, customerId: customerB });
  assert.deepEqual(otherShop.body.details.fields, [{ field: 'customerId', code: 'NOT_FOUND' }]);
  assert.equal((await preview(draft, { cookie: ownerB })).status, 404, '다른 매장 원장은 경로부터 404');
});

test('변경: 자기 자신과는 겹치지 않고 조금 옮길 수 있다, 오래된 version은 409, 보낸 필드만 바뀐다', async () => {
  const made = await book({ startAt: at('10', '10:00'), menuId: menuA, memo: '그대로' });
  const moved = await patch(made.body.id, { version: 1, startAt: at('10', '10:15') });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.version, 2);
  assert.equal(moved.body.startAt, '2026-12-10T01:15:00.000Z');
  assert.equal(moved.body.memo, '그대로');
  assert.equal(moved.body.menuId, menuA);
  const stale = await patch(made.body.id, { version: 1, memo: '늦은 수정' });
  assert.equal(stale.status, 409);
  assert.deepEqual(stale.body.details, { currentVersion: 2 });
  assert.equal((await patch(made.body.id, { memo: 'x' })).body.details.fields[0].code, 'REQUIRED');
  assert.equal((await patch(made.body.id, { version: 2, status: 'cancelled' })).body.details.fields[0].code, 'UNKNOWN_FIELD');
  const cleared = await patch(made.body.id, { version: 2, menuId: null, memo: null });
  assert.deepEqual([cleared.body.menuId, cleared.body.menuName, cleared.body.memo, cleared.body.version], [null, null, null, 3]);
  assert.equal((await patch(randomUUID(), { version: 1, memo: 'x' })).status, 404);
  assert.equal((await patch(made.body.id, { version: 3, memo: 'x' }, { cookie: ownerB })).status, 404);
});

test('변경 재판정 범위(D2): 메모만은 판정 없음, 정리만은 겹침만, 길이가 마감을 넘으면 영업시간 경고', async () => {
  // 영업시간을 줄이기 전에 만들어진 예약 — 일요일 행을 직접 넣는다(파생 S2: 기존 예약은 그대로 남는다).
  const { rows: [{ id: sunday }] } = await admin.query(`INSERT INTO crm.appointment_m1 (shop_id, customer_id, staff_id, start_at, duration_min)
    VALUES ($1, $2, $3, '2026-12-13T01:00:00Z', 60) RETURNING id`, [shopA, customerOff, staffOff]);
  assert.deepEqual(warn(await patch(sunday, { version: 1, memo: '메모만' })), [], '비활성 고객·담당자의 기존 예약도 메모는 고친다');
  assert.deepEqual(warn(await patch(sunday, { version: 2, cleanupMin: 15 })), [], '정리만 바꾸면 영업시간을 보지 않는다');
  assert.deepEqual(warn(await patch(sunday, { version: 3, durationMin: 90 })), [['CLOSED_DAY']], '종료가 바뀌면 재판정');
  assert.deepEqual((await patch(sunday, { version: 4, staffId: staffOff, customerId: customerOff, memo: '같은 값' })).status, 200,
    '같은 참조를 다시 보내는 것은 바꾸는 것이 아니다');

  const a = await book({ startAt: at('11', '10:00') });
  const b = await book({ startAt: at('11', '11:00') });
  const cleanupClash = await patch(a.body.id, { version: 1, cleanupMin: 30 }); // a 점유 ~11:30 → b(11:00~)와 겹침
  assert.deepEqual([cleanupClash.status, ...warn(cleanupClash)], [200, ['OVERLAP_APPOINTMENT', b.body.id]]);
  assert.deepEqual(warn(await patch(b.body.id, { version: 1, durationMin: 600 })), [['OVERLAP_APPOINTMENT', a.body.id], ['OUTSIDE_BUSINESS_HOURS']]);
  assert.equal((await patch(b.body.id, { version: 2, staffId: staffOff })).body.details.fields[0].code, 'INACTIVE');
  assert.equal((await patch(b.body.id, { version: 2, customerId: customerB })).body.details.fields[0].code, 'NOT_FOUND');
  const toOther = await patch(b.body.id, { version: 2, staffId: staff2, durationMin: 60, startAt: at('11', '10:00') });
  assert.deepEqual([toOther.status, ...warn(toOther)], [200], '다른 담당자로 옮기면 같은 시각도 경고 없음');
  assert.deepEqual(warn(await patch(b.body.id, { version: 3, staffId: staff1 })), [['OVERLAP_APPOINTMENT', a.body.id]]);
});
