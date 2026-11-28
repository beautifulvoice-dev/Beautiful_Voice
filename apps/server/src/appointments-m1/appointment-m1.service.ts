import type { Appointment, AppointmentSaved, AppointmentStatus, BookingWarning, CalendarResponse, Staff } from '@bv/contracts';
import { changeStatus, OCCUPYING } from '@bv/scheduling/appointment-status';
import type { Closure, Interval, ShopHours } from '@bv/scheduling/booking';
import { appointmentWarnings, CLEANUP_RANGE, DURATION_RANGE, minutesWithin, occupancyOf, type OccupyingAppointment } from '@bv/scheduling/warnings';
import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { activeBlocksIn, blockedByOf, blocksInRange } from '../calendar-blocks/block-queries';
import { ApiError } from '../common/api-error';
import { lockShopWrites } from '../common/shop-lock';
import { dismissPendingCompletion, lockPendingCompletion } from '../completion/appointment-card';

// M1 예약 쓰기(BEA-176·160) — `crm.appointment_m1`만 쓴다. 006 `crm.appointment`(옛 C-07 서비스, src/appointments)는
// 이행 합의 전까지 건드리지 않는다. 모든 함수는 DatabaseService.withShop 트랜잭션의 client를 받고,
// RLS와 별개로 쿼리마다 shop_id 조건을 쓴다(절대 규칙 5).
// S3 rev.3.1(§4.2): 웹 수동 저장은 겹침·차단·영업시간 밖·휴무를 거부하지 않고 warnings와 함께 저장한다.
// 판정은 @bv/scheduling/warnings, 저장 판정은 매장 쓰기 잠금(lockShopWrites) 안에서 최신 행으로 한다(절대 규칙 4).
// 미리 보기는 같은 계산(planCreate·planUpdate)을 잠금·쓰기 없이 돌린다.
@Injectable()
export class AppointmentM1Service {
  async find(client: PoolClient, shopId: string, id: string): Promise<Appointment> {
    if (!UUID.test(id)) throw appointmentNotFound();
    const { rows: [row] } = await client.query<ViewRow>(`${VIEW_SELECT} WHERE a.shop_id = $1 AND a.id = $2`, [shopId, id]);
    if (!row) throw appointmentNotFound();
    return (await withConflicts(client, shopId, [row]))[0]!;
  }

  /**
   * 캘린더 한 화면치(#42 GET …/calendar, 설계 04 보강 D5~D7). from·to는 매장 날짜(양 끝 포함, 1~42일).
   * 점유 [시작, 시작+시술+정리)가 [from 0시, to 다음 날 0시)와 겹치는 예약 — 경계에 닿기만 하면 빠진다.
   * 취소·무효도 보낸다(D6, 화면이 뺀다). 담당자는 활성 + 응답 예약·차단이 가리키는 비활성(04 D7·09 D6).
   * 차단은 기간과 겹치는 활성 차단. 예약의 blockedBy·overlappingAppointmentIds는 기간 밖 행까지 보고 조회 시점에 계산한다.
   * 컨트롤러가 한 스냅샷에서 부른다.
   */
  async calendar(client: PoolClient, shopId: string, query: { from?: unknown; to?: unknown }): Promise<CalendarResponse> {
    const range = readRange(query.from, query.to);
    // ASSUMPTION: M1 매장 시간대는 Asia/Seoul 고정(설계 04, 운영 중 시간대 변경은 범위 밖).
    const { rows } = await client.query<ViewRow>(
      `${VIEW_SELECT}
        WHERE a.shop_id = $1
          AND a.occupied && tstzrange($2::date::timestamp AT TIME ZONE '${SHOP_TIME_ZONE}',
                                      ($3::date + 1)::timestamp AT TIME ZONE '${SHOP_TIME_ZONE}', '[)')
        ORDER BY a.start_at, a.id`, [shopId, range.from, range.to]);
    const appointments = await withConflicts(client, shopId, rows);
    // ASSUMPTION: 매장 시간대 Asia/Seoul(+09:00, 일광절약 없음) 고정 — 위 SQL과 같은 경계.
    const blocks = await blocksInRange(client, shopId, new Date(`${range.from}T00:00:00+09:00`), new Date(`${nextDay(range.to)}T00:00:00+09:00`));
    const staffIds = [...appointments.map((a) => a.staffId), ...blocks.flatMap((b) => b.staffIds)].filter((v): v is string => v !== null);
    const { rows: staff } = await client.query<Staff>(
      `SELECT id, version, created_at AS "createdAt", updated_at AS "updatedAt", name, active
         FROM crm.staff WHERE shop_id = $1 AND (active OR id = ANY($2::uuid[])) ORDER BY created_at, id`,
      [shopId, [...new Set(staffIds)]]);
    return { staff, appointments, blocks };
  }

  /**
   * 상태 바꾸기·정정(#42 PUT …/status, 설계 04 보강 §예약 취소와 상태 API). 판정은 @bv/scheduling changeStatus(결정 S5).
   * 취소를 되살리면 예약·차단 겹침을 warnings로 알리고 저장한다(설계 12 §3). 영업시간·휴무는 보지 않는다(Q2).
   * 예정 예약을 닫으면 같은 트랜잭션에서 미승인 완료 카드를 해제한다.
   */
  async setStatus(client: PoolClient, shopId: string, id: string, input: unknown): Promise<AppointmentSaved> {
    if (!UUID.test(id)) throw appointmentNotFound();
    const { version, status } = readStatusInput(input);
    await lockShopWrites(client, shopId);
    const cardId = status !== 'scheduled' ? await lockPendingCompletion(client, shopId, id) : undefined;
    const current = await loadCurrent(client, shopId, id, true);
    if (!current) throw appointmentNotFound();
    if (current.version !== version) throw versionConflict(current.version);
    const change = changeStatus(current.status, status, { undoOfTask: false });
    if (!change.ok) {
      throw change.error === 'NO_CHANGE'
        ? new ApiError(409, 'NO_CHANGE', '이미 같은 상태입니다.')
        : new ApiError(409, 'INVALID_TRANSITION', '이 상태로 바꿀 수 없습니다.', { current: current.status });
    }
    const warnings = change.needsOverlapCheck
      ? await judge(client, shopId, toFields(current), { hours: false, overlap: true, excludeId: id }) : [];
    await client.query('UPDATE crm.appointment_m1 SET status = $3 WHERE shop_id = $1 AND id = $2', [shopId, id, status]);
    if (cardId && current.status === 'scheduled') await dismissPendingCompletion(client, shopId, cardId, 'status_changed');
    return saved(await this.find(client, shopId, id), warnings);
  }

  async create(client: PoolClient, shopId: string, input: unknown): Promise<AppointmentSaved> {
    const { values } = readInput(input, 'create');
    // 업무 조회 전에 매장 쓰기 잠금 — 차단 등록과 순서를 맞춘다(Q3). 이후 조회는 먼저 커밋된 예약·차단을 본다.
    await lockShopWrites(client, shopId);
    const { next, warnings } = await planCreate(client, shopId, values);
    // 메뉴 이름은 저장 시점의 이름을 남긴다(menu_name_snapshot, 015) — 메뉴 이름이 나중에 바뀌어도 예약 쪽은 그대로.
    const { rows: [row] } = await client.query<{ id: string }>(
      `INSERT INTO crm.appointment_m1
         (shop_id, customer_id, menu_id, staff_id, start_at, duration_min, cleanup_min, memo, menu_name_snapshot)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, (SELECT m.name FROM crm.menu m WHERE m.shop_id = $1 AND m.id = $3))
       RETURNING id`,
      [shopId, next.customerId, next.menuId, next.staffId, next.start, next.durationMin, next.cleanupMin, next.memo]);
    return saved(await this.find(client, shopId, row!.id), warnings);
  }

  /** 보낸 필드만 바꾼다. 상태는 /status(BEA-178)에서. */
  async update(client: PoolClient, shopId: string, id: string, input: unknown): Promise<AppointmentSaved> {
    if (!UUID.test(id)) throw appointmentNotFound();
    const { values, version } = readInput(input, 'patch');
    await lockShopWrites(client, shopId);
    const cardId = COMPLETION_FIELDS.some((field) => values[field] !== undefined)
      ? await lockPendingCompletion(client, shopId, id) : undefined;
    const current = await loadCurrent(client, shopId, id, true);
    if (!current) throw appointmentNotFound();
    if (current.version !== version) throw versionConflict(current.version);
    const { after, changed, warnings } = await planUpdate(client, shopId, id, current, values);
    if (changed.length > 0) {
      const columns = changed.map((k, i) => `${COLUMN[k]} = $${i + 3}`);
      if (changed.includes('menuId')) {
        columns.push(`menu_name_snapshot = (SELECT m.name FROM crm.menu m WHERE m.shop_id = $1 AND m.id = $${changed.indexOf('menuId') + 3})`);
      }
      await client.query(
        `UPDATE crm.appointment_m1 SET ${columns.join(', ')} WHERE shop_id = $1 AND id = $2`,
        [shopId, id, ...changed.map((k) => after[k])]);
      if (cardId && changed.some((field) => COMPLETION_FIELDS.includes(field))) {
        await dismissPendingCompletion(client, shopId, cardId, 'rescheduled');
      }
    }
    return saved(await this.find(client, shopId, id), warnings);
  }

  /**
   * 저장 전 경고(설계 12 D4). 새 예약 또는 기존 예약 수정({appointmentId, version, 바꿀 필드}) — 저장과 같은 계산이다.
   * 읽기 전용: 잠금·멱등키·쓰기가 없다. 결과는 뒤이은 저장 시점까지 보장되지 않는다(저장 응답의 warnings가 최종).
   * ASSUMPTION: 본문의 appointmentId가 이 매장에 없으면 다른 본문 id처럼 422 appointmentId NOT_FOUND(주드 11/26 규칙 — 본문 id는 422).
   */
  async previewWarnings(client: PoolClient, shopId: string, input: unknown): Promise<{ warnings: BookingWarning[] }> {
    const edit = input !== null && typeof input === 'object' && !Array.isArray(input) && 'appointmentId' in input;
    if (!edit) return { warnings: (await planCreate(client, shopId, readInput(input, 'preview-new').values)).warnings };
    const { values, version, appointmentId } = readInput(input, 'preview-edit');
    const current = await loadCurrent(client, shopId, appointmentId!, false);
    if (!current) throw invalid([{ field: 'appointmentId', code: 'NOT_FOUND' }]);
    if (current.version !== version) throw versionConflict(current.version);
    return { warnings: (await planUpdate(client, shopId, appointmentId!, current, values)).warnings };
  }
}

/** 새 예약: 참조·담당자 필수 확인 → 경고. 저장(create)과 미리 보기가 함께 쓴다. */
async function planCreate(client: PoolClient, shopId: string, values: Partial<Fields>): Promise<{ next: Fields; warnings: BookingWarning[] }> {
  const next = { menuId: null, staffId: null, cleanupMin: 0, memo: null, ...values } as Fields;
  await checkReferences(client, shopId, next);
  await requireStaff(client, shopId, next.staffId);
  return { next, warnings: await judge(client, shopId, next, { hours: true, overlap: true }) };
}

/** 기존 예약 수정: 보낸 값을 합치고, 바뀐 것만 확인 → 경고. 저장(update)과 미리 보기가 함께 쓴다. */
async function planUpdate(
  client: PoolClient, shopId: string, id: string, current: StoredRow, values: Partial<Fields>,
): Promise<{ after: Fields; changed: (keyof Fields)[]; warnings: BookingWarning[] }> {
  const before = toFields(current);
  const after: Fields = { ...before, ...values };
  const changed = (KEYS as readonly (keyof Fields)[]).filter((k) => (k === 'start'
    ? after.start.getTime() !== before.start.getTime() : after[k] !== before[k]));
  if (changed.length === 0) return { after, changed, warnings: [] };
  const has = (k: keyof Fields) => changed.includes(k);

  // D3: 바꾸는 참조만 확인한다 — 기존 예약의 비활성 고객·담당자는 그대로 둔 채 메모·시간을 고칠 수 있다.
  await checkReferences(client, shopId, {
    customerId: has('customerId') ? after.customerId : undefined,
    staffId: has('staffId') ? after.staffId : undefined,
    menuId: has('menuId') ? after.menuId : undefined,
  });
  // 설계 12 D3: 담당자 필수 설정은 시간·담당자 변경에만 적용 — 기존 미지정 예약의 메모 수정은 그대로 된다.
  const timeOrStaff = (['start', 'durationMin', 'cleanupMin', 'staffId'] as const).some(has);
  if (timeOrStaff) await requireStaff(client, shopId, after.staffId);
  // D2: 시술 시작이나 종료가 바뀌면 영업시간·휴무 재판정. Q1: 시작·시술·정리·담당자가 바뀌면 겹침·차단 재판정(점유 중인 상태만).
  // 메뉴·메모·고객만 바뀌면 판정하지 않는다(warnings = []). 겹침에서 자기 자신은 뺀다.
  const hours = has('start') || endOf(after) !== endOf(before);
  const overlap = OCCUPYING.has(current.status) && timeOrStaff;
  const warnings = hours || overlap ? await judge(client, shopId, after, { hours, overlap, excludeId: id }) : [];
  return { after, changed, warnings };
}

async function judge(
  client: PoolClient, shopId: string, next: Fields, check: { hours: boolean; overlap: boolean; excludeId?: string },
): Promise<BookingWarning[]> {
  const hours = check.hours ? await shopHours(client, shopId) : NO_HOURS;
  const slot = { staffId: next.staffId, start: next.start, durationMin: next.durationMin, cleanupMin: next.cleanupMin };
  const occupied = occupancyOf(slot);
  // 점유 구간에 걸리는 예약·활성 차단을 담당자 구분 없이 읽고, 담당자 조건(미지정은 누구와도)은 순수 함수가 거른다.
  const existing = check.overlap ? await occupyingRows(client, shopId, occupied, check.excludeId) : [];
  const blocks = check.overlap ? await activeBlocksIn(client, shopId, occupied) : [];
  return appointmentWarnings(slot, hours, existing, blocks, { excludeId: check.excludeId, skipHoursCheck: !check.hours });
}

const NO_HOURS: ShopHours = { businessHours: null, closures: [] };

/** 담당자 필수 설정(shop_settings.require_staff_selection)이 켜졌는데 미지정이면 422 staffId REQUIRED. */
async function requireStaff(client: PoolClient, shopId: string, staffId: string | null): Promise<void> {
  if (staffId !== null) return;
  const { rows: [settings] } = await client.query<{ require_staff_selection: boolean }>(
    'SELECT require_staff_selection FROM crm.shop_settings WHERE shop_id = $1', [shopId]);
  if (settings?.require_staff_selection) {
    throw new ApiError(422, 'VALIDATION_FAILED', '담당자를 선택해 주세요.', { fields: [{ field: 'staffId', code: 'REQUIRED' }] });
  }
}

async function loadCurrent(client: PoolClient, shopId: string, id: string, forUpdate: boolean): Promise<StoredRow | undefined> {
  const { rows: [row] } = await client.query<StoredRow>(
    `SELECT customer_id, menu_id, staff_id, start_at, duration_min, cleanup_min, memo, status, version
       FROM crm.appointment_m1 WHERE shop_id = $1 AND id = $2${forUpdate ? ' FOR UPDATE' : ''}`, [shopId, id]);
  return row;
}

async function occupyingRows(
  client: PoolClient, shopId: string, occupied: Interval, excludeId: string | undefined,
): Promise<OccupyingAppointment[]> {
  const { rows } = await client.query<{ id: string; staff_id: string | null; status: AppointmentStatus; start: Date; end: Date }>(
    `SELECT id, staff_id, status, lower(occupied) AS start, upper(occupied) AS "end" FROM crm.appointment_m1
      WHERE shop_id = $1 AND status NOT IN ('cancelled', 'voided')
        AND occupied && tstzrange($2, $3, '[)') AND id IS DISTINCT FROM $4::uuid
      ORDER BY start_at, id`,
    [shopId, occupied.start, occupied.end, excludeId ?? null]);
  return rows.map((r) => ({ id: r.id, staffId: r.staff_id, status: r.status, occupied: { start: r.start, end: r.end } }));
}

async function shopHours(client: PoolClient, shopId: string): Promise<ShopHours> {
  const { rows: [settings] } = await client.query<{ business_hours: ShopHours['businessHours'] }>(
    'SELECT business_hours FROM crm.shop_settings WHERE shop_id = $1', [shopId]);
  const { rows } = await client.query<{ kind: string; weekday: number | null; start_date: string | null; end_date: string | null }>(
    'SELECT kind, weekday, start_date::text AS start_date, end_date::text AS end_date FROM crm.shop_closure WHERE shop_id = $1', [shopId]);
  const closures = rows.map((r) => (r.kind === 'weekly'
    ? { kind: 'weekly', weekday: r.weekday } : { kind: r.kind, startDate: r.start_date, endDate: r.end_date }) as Closure);
  return { businessHours: settings?.business_hours ?? null, closures };
}

/** 고객·담당자·메뉴가 이 매장 것인지. 다른 매장 id는 "없음"과 같은 답을 준다(존재 여부를 숨김). */
async function checkReferences(
  client: PoolClient, shopId: string, refs: { customerId?: string; staffId?: string | null; menuId?: string | null },
): Promise<void> {
  const errors: FieldError[] = [];
  // ASSUMPTION: 비활성 고객·담당자는 새 예약이나 그 참조를 바꾸는 요청에서 거부한다(설계 D3, PM 답변 전).
  // 메뉴의 활성 여부는 결정이 없어 소속만 확인한다.
  for (const [field, table, ref] of [['customerId', 'customer', refs.customerId], ['staffId', 'staff', refs.staffId], ['menuId', 'menu', refs.menuId]] as const) {
    if (!ref) continue;
    const { rows: [row] } = await client.query<{ active: boolean }>(`SELECT active FROM crm.${table} WHERE shop_id = $1 AND id = $2`, [shopId, ref]);
    if (!row) errors.push({ field, code: 'NOT_FOUND' });
    else if (!row.active && field !== 'menuId') errors.push({ field, code: 'INACTIVE' });
  }
  if (errors.length > 0) throw invalid(errors);
}

// ── 입력 ──
const KEYS = ['customerId', 'menuId', 'staffId', 'start', 'durationMin', 'cleanupMin', 'memo'] as const;
type Fields = {
  customerId: string; menuId: string | null; staffId: string | null; start: Date; durationMin: number; cleanupMin: number; memo: string | null;
};
const COMPLETION_FIELDS: readonly (keyof Fields)[] = ['start', 'durationMin', 'menuId', 'staffId'];
const COLUMN: Record<keyof Fields, string> = {
  customerId: 'customer_id', menuId: 'menu_id', staffId: 'staff_id', start: 'start_at',
  durationMin: 'duration_min', cleanupMin: 'cleanup_min', memo: 'memo',
};
// prepMin은 S3 전환 기간의 옛 이름(= cleanupMin). 웹 전환(③)·배포 뒤 지운다.
const BODY_FIELDS = ['customerId', 'menuId', 'staffId', 'startAt', 'durationMin', 'cleanupMin', 'prepMin', 'memo'];
export type FieldError = { field: string; code: string };
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// 시각은 offset을 꼭 붙인다(계약: ISO-8601+offset). offset 없는 시각은 서버 시간대에 따라 뜻이 달라진다.
const ISO = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

// preview-new: 새 예약 미리 보기 — 등록과 같지만 customerId는 선택(고객을 고르기 전에도 폼이 부른다, 옵마 11/27 결정).
// 겹침·차단·영업시간·휴무 판정에 고객은 쓰지 않는다. 보내면 등록과 같이 형식·소속을 검사한다.
type InputMode = 'create' | 'preview-new' | 'patch' | 'preview-edit';

function readInput(input: unknown, mode: InputMode): { values: Partial<Fields>; version: number | null; appointmentId: string | null } {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw invalid([{ field: '', code: 'INVALID_SHAPE' }]);
  const body = input as Record<string, unknown>;
  const errors: FieldError[] = [];
  const values: Partial<Fields> = {};
  const create = mode === 'create' || mode === 'preview-new';
  const given = (k: string) => body[k] !== undefined;
  const need = (k: string) => { if (create) errors.push({ field: k, code: 'REQUIRED' }); };
  const extra = mode === 'patch' ? ['version'] : mode === 'preview-edit' ? ['version', 'appointmentId'] : [];
  // 상태(status) 등 모르는 칸은 조용히 무시하지 않고 거부한다 — 바뀐 줄 알고 넘어가지 않게.
  for (const k of Object.keys(body)) if (!BODY_FIELDS.includes(k) && !extra.includes(k)) errors.push({ field: k, code: 'UNKNOWN_FIELD' });

  if (!given('customerId')) { if (mode === 'create') need('customerId'); }
  else if (typeof body.customerId === 'string' && UUID.test(body.customerId)) values.customerId = body.customerId.toLowerCase();
  else errors.push({ field: 'customerId', code: 'INVALID_ID' });
  // 메뉴·담당자: null은 비우기(담당자 미지정). 등록에서 생략하면 null, 수정에서 생략하면 그대로.
  for (const k of ['menuId', 'staffId'] as const) {
    if (!given(k)) continue;
    const v = body[k];
    if (v === null) values[k] = null;
    else if (typeof v === 'string' && UUID.test(v)) values[k] = v.toLowerCase();
    else errors.push({ field: k, code: 'INVALID_ID' });
  }
  if (!given('startAt')) need('startAt');
  else {
    const start = parseInstant(body.startAt);
    if (start) values.start = start;
    else errors.push({ field: 'startAt', code: 'INVALID_DATETIME' });
  }
  // 분 단위 정수. 시술 5~600, 정리 0~180(rev.3.1, DB CHECK 015와 같음). 정리는 새 이름과 옛 이름 중 하나만 받는다.
  if (given('cleanupMin') && given('prepMin')) errors.push({ field: 'prepMin', code: 'DUPLICATE_FIELD' });
  const cleanupKey = given('prepMin') ? 'prepMin' : 'cleanupMin';
  for (const [k, field, range] of [['durationMin', 'durationMin', DURATION_RANGE], [cleanupKey, 'cleanupMin', CLEANUP_RANGE]] as const) {
    const v = body[k];
    if (!given(k)) { if (k === 'durationMin') need(k); }
    else if (typeof v === 'number' && minutesWithin(v, range)) values[field] = v;
    else errors.push({ field: k, code: 'INVALID_MINUTES' });
  }
  if (given('memo')) {
    const v = body.memo;
    if (v === null || typeof v === 'string') values.memo = typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
    else errors.push({ field: 'memo', code: 'INVALID_TYPE' });
  }
  let version: number | null = null;
  if (!create) {
    const v = body.version;
    if (typeof v === 'number' && Number.isInteger(v) && v >= 1) version = v;
    else errors.push({ field: 'version', code: v === undefined ? 'REQUIRED' : 'INVALID_VERSION' });
  }
  let appointmentId: string | null = null;
  if (mode === 'preview-edit') {
    const v = body.appointmentId;
    if (typeof v === 'string' && UUID.test(v)) appointmentId = v.toLowerCase();
    else errors.push({ field: 'appointmentId', code: 'INVALID_ID' });
  }
  if (errors.length > 0) throw invalid(errors);
  return { values, version, appointmentId };
}

export function parseInstant(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const m = ISO.exec(value);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  // 2026-02-30처럼 없는 날짜는 JS Date가 다음 달로 넘겨 버리므로 직접 거른다.
  const day = new Date(Date.UTC(y, mo - 1, d));
  if (day.getUTCFullYear() !== y || day.getUTCMonth() !== mo - 1 || day.getUTCDate() !== d) return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at;
}

const SHOP_TIME_ZONE = 'Asia/Seoul';
const MAX_RANGE_DAYS = 42;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const SETTABLE: readonly AppointmentStatus[] = ['scheduled', 'completed', 'cancelled', 'no_show'];

/** 매장 날짜 'YYYY-MM-DD'를 날짜 번호(1970-01-01부터 며칠째)로. 없는 날짜·다른 모양은 null. */
function dayNumber(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const m = DATE.exec(value);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const day = new Date(Date.UTC(y, mo - 1, d));
  if (day.getUTCFullYear() !== y || day.getUTCMonth() !== mo - 1 || day.getUTCDate() !== d) return null;
  return day.getTime() / 86_400_000;
}

/** 빠짐·없는 날짜·역순·42일 초과는 400 INVALID_RANGE(설계 04 보강 §캘린더 기간 조회). */
function readRange(from: unknown, to: unknown): { from: string; to: string } {
  const [f, t] = [dayNumber(from), dayNumber(to)];
  if (f === null || t === null || t < f || t - f + 1 > MAX_RANGE_DAYS) {
    throw new ApiError(400, 'INVALID_RANGE', `조회 기간은 매장 날짜 from~to(양 끝 포함) 1~${MAX_RANGE_DAYS}일이어야 합니다.`);
  }
  return { from: from as string, to: to as string };
}

function readStatusInput(input: unknown): { version: number; status: AppointmentStatus } {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw invalid([{ field: '', code: 'INVALID_SHAPE' }]);
  const body = input as Record<string, unknown>;
  const errors: FieldError[] = [];
  for (const k of Object.keys(body)) if (k !== 'version' && k !== 'status') errors.push({ field: k, code: 'UNKNOWN_FIELD' });
  const { version, status } = body;
  if (!(typeof version === 'number' && Number.isInteger(version) && version >= 1)) {
    errors.push({ field: 'version', code: version === undefined ? 'REQUIRED' : 'INVALID_VERSION' });
  }
  // 무효(voided)는 업무 되돌리기 전용이라 여기서 고를 수 없다(#42 enum).
  if (!SETTABLE.includes(status as AppointmentStatus)) {
    errors.push({ field: 'status', code: status === undefined ? 'REQUIRED' : 'INVALID_STATUS' });
  }
  if (errors.length > 0) throw invalid(errors);
  return { version: version as number, status: status as AppointmentStatus };
}

// ── 출력·오류 ──
// 메뉴 이름은 예약에 저장한 스냅샷(015)이다 — 메뉴 이름이 나중에 바뀌어도 예약 카드는 그대로.
const VIEW_SELECT = `SELECT a.id, a.customer_id, a.menu_id, a.staff_id, a.start_at, a.duration_min, a.cleanup_min, a.memo, a.status,
              a.version, a.created_at, a.updated_at, c.name AS customer_name, a.menu_name_snapshot AS menu_name
         FROM crm.appointment_m1 a
         JOIN crm.customer c ON c.shop_id = a.shop_id AND c.id = a.customer_id`;

export function versionConflict(currentVersion: number): ApiError<'VERSION_CONFLICT'> {
  return new ApiError(409, 'VERSION_CONFLICT', '다른 곳에서 먼저 고쳤습니다. 새로 불러와 주세요.', { currentVersion });
}
interface StoredRow {
  customer_id: string; menu_id: string | null; staff_id: string | null; start_at: Date; duration_min: number; cleanup_min: number;
  memo: string | null; status: AppointmentStatus; version: number;
}
interface ViewRow extends StoredRow { id: string; created_at: Date; updated_at: Date; customer_name: string; menu_name: string | null }

function toFields(r: StoredRow): Fields {
  return {
    customerId: r.customer_id, menuId: r.menu_id, staffId: r.staff_id, start: r.start_at, durationMin: r.duration_min,
    cleanupMin: r.cleanup_min, memo: r.memo,
  };
}
function endOf(f: Fields): number {
  return f.start.getTime() + f.durationMin * 60_000;
}

/** 조회 행에 겹침 표시(차단 blockedBy·예약 overlappingAppointmentIds)를 붙인다 — 조회 시점 계산, 행에 저장하지 않는다(09 D5). */
async function withConflicts(client: PoolClient, shopId: string, rows: ViewRow[]): Promise<Appointment[]> {
  const ids = rows.map((r) => r.id);
  const [blockedBy, overlapping] = [await blockedByOf(client, shopId, ids), await overlappingOf(client, shopId, ids)];
  return rows.map((r) => toAppointment(r, blockedBy.get(r.id), overlapping.get(r.id)));
}

/** 예약 id → 점유가 겹치는 다른 점유 예약 id(같은 담당자 또는 한쪽 미지정, 시작·id 순). 취소·무효는 빈 배열. */
async function overlappingOf(client: PoolClient, shopId: string, ids: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (ids.length === 0) return out;
  const { rows } = await client.query<{ appointment_id: string; other_id: string }>(
    `SELECT a.id AS appointment_id, o.id AS other_id
       FROM crm.appointment_m1 a
       JOIN crm.appointment_m1 o
         ON o.shop_id = a.shop_id AND o.id <> a.id AND o.status IN ('scheduled', 'completed', 'no_show')
        AND o.occupied && a.occupied AND (a.staff_id IS NULL OR o.staff_id IS NULL OR o.staff_id = a.staff_id)
      WHERE a.shop_id = $1 AND a.id = ANY($2::uuid[]) AND a.status IN ('scheduled', 'completed', 'no_show')
      ORDER BY o.start_at, o.id`, [shopId, ids]);
  for (const r of rows) out.set(r.appointment_id, [...(out.get(r.appointment_id) ?? []), r.other_id]);
  return out;
}

function toAppointment(r: ViewRow, blockedBy: string[] = [], overlappingAppointmentIds: string[] = []): Appointment {
  return {
    id: r.id, customerId: r.customer_id, menuId: r.menu_id, staffId: r.staff_id, startAt: r.start_at.toISOString(),
    // prepMin은 S3 전환 기간의 옛 이름(= cleanupMin) — 웹 전환(③)·배포 뒤 지운다.
    durationMin: r.duration_min, cleanupMin: r.cleanup_min, prepMin: r.cleanup_min, memo: r.memo, status: r.status, version: r.version,
    createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(),
    customerName: r.customer_name, menuName: r.menu_name, blockedBy, overlappingAppointmentIds,
  };
}

function saved(appointment: Appointment, warnings: BookingWarning[]): AppointmentSaved {
  return { ...appointment, warnings };
}

export function invalid(fields: FieldError[]): ApiError<'VALIDATION_FAILED'> {
  return new ApiError(422, 'VALIDATION_FAILED', '입력값을 확인해 주세요.', { fields });
}

function appointmentNotFound(): ApiError<'NOT_FOUND'> {
  return notFound('예약을 찾을 수 없습니다.');
}

export function notFound(message: string): ApiError<'NOT_FOUND'> {
  return new ApiError(404, 'NOT_FOUND', message);
}

/** 'YYYY-MM-DD' 다음 날. */
function nextDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
