import type { Appointment, AppointmentStatus, CalendarResponse, Staff } from '@bv/contracts';
import { changeStatus, OCCUPYING } from '@bv/scheduling/appointment-status';
import type { Closure, Interval, ShopHours } from '@bv/scheduling/booking';
import {
  appointmentWarnings, type BookingWarning, CLEANUP_RANGE, DURATION_RANGE, minutesWithin, occupancyOf, type OccupyingAppointment, type WarningCode,
} from '@bv/scheduling/warnings';
import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { activeBlocksIn, blockedByOf, blocksInRange } from '../calendar-blocks/block-queries';
import { ApiError } from '../common/api-error';
import { lockShopWrites } from '../common/shop-lock';

// M1 예약 쓰기(BEA-176·160) — `crm.appointment_m1`만 쓴다. 006 `crm.appointment`(옛 C-07 서비스, src/appointments)는
// 이행 합의 전까지 건드리지 않는다. 모든 함수는 DatabaseService.withShop 트랜잭션의 client를 받고,
// RLS와 별개로 쿼리마다 shop_id 조건을 쓴다(절대 규칙 5). 판정은 @bv/scheduling/warnings(S3 rev.3.1) — 겹침 배타 제약은 015에서 없앴고,
// 겹침은 매장 쓰기 잠금(lockShopWrites) 안에서 최신 행으로 판정한다(절대 규칙 4).
// ASSUMPTION(S3 단계 이행): API 이름 prepMin은 S3 서버 PR에서 cleanupMin으로 바뀐다. 값은 이미 시술 뒤 정리 시간(cleanup_min)이다.
@Injectable()
export class AppointmentM1Service {
  async find(client: PoolClient, shopId: string, id: string): Promise<Appointment> {
    if (!UUID.test(id)) throw appointmentNotFound();
    const { rows: [row] } = await client.query<ViewRow>(`${VIEW_SELECT} WHERE a.shop_id = $1 AND a.id = $2`, [shopId, id]);
    if (!row) throw appointmentNotFound();
    // 차단 겹침은 조회 때 계산한다(설계 09 D5) — 예약 행에 저장하지 않는다.
    return toAppointment(row, (await blockedByOf(client, shopId, [row.id])).get(row.id));
  }

  /**
   * 캘린더 한 화면치(#42 GET …/calendar, 설계 04 보강 D5~D7). from·to는 매장 날짜(양 끝 포함, 1~42일).
   * 점유 [시작, 시작+시술+정리)가 [from 0시, to 다음 날 0시)와 겹치는 예약 — 경계에 닿기만 하면 빠진다.
   * 취소·무효도 보낸다(D6, 화면이 뺀다). 담당자는 활성 + 응답 예약·차단이 가리키는 비활성(04 D7·09 D6).
   * 차단은 기간과 겹치는 활성 차단, blockedBy는 예약 전체 점유와 겹치는 활성 차단(09 D5). 컨트롤러가 한 스냅샷에서 부른다.
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
    const blockedBy = await blockedByOf(client, shopId, rows.map((r) => r.id));
    const appointments = rows.map((r) => toAppointment(r, blockedBy.get(r.id)));
    // ASSUMPTION: 매장 시간대 Asia/Seoul(+09:00, 일광절약 없음) 고정 — 위 SQL과 같은 경계.
    const blocks = await blocksInRange(client, shopId, new Date(`${range.from}T00:00:00+09:00`), new Date(`${nextDay(range.to)}T00:00:00+09:00`));
    const { rows: staff } = await client.query<Staff>(
      `SELECT id, version, created_at AS "createdAt", updated_at AS "updatedAt", name, active
         FROM crm.staff WHERE shop_id = $1 AND (active OR id = ANY($2::uuid[])) ORDER BY created_at, id`,
      [shopId, [...new Set([...appointments.map((a) => a.staffId), ...blocks.flatMap((b) => b.staffIds)])]]);
    return { staff, appointments, blocks };
  }

  /**
   * 상태 바꾸기·정정(#42 PUT …/status, 설계 04 보강 §예약 취소와 상태 API). 판정은 @bv/scheduling changeStatus(결정 S5).
   * 취소를 되살리면 같은 담당자 점유 겹침만 다시 본다(Q2) — 영업시간·휴무·차단으로는 거부하지 않는다(차단과 겹치면 blockedBy로 표시).
   * 지갑·문자는 건드리지 않는다.
   */
  async setStatus(client: PoolClient, shopId: string, id: string, input: unknown): Promise<Appointment> {
    if (!UUID.test(id)) throw appointmentNotFound();
    const { version, status } = readStatusInput(input);
    await lockShopWrites(client, shopId);
    const { rows: [current] } = await client.query<StoredRow>(
      `SELECT customer_id, menu_id, staff_id, start_at, duration_min, cleanup_min, memo, status, version
         FROM crm.appointment_m1 WHERE shop_id = $1 AND id = $2 FOR UPDATE`, [shopId, id]);
    if (!current) throw appointmentNotFound();
    if (current.version !== version) throw versionConflict(current.version);
    const change = changeStatus(current.status, status, { undoOfTask: false });
    if (!change.ok) {
      throw change.error === 'NO_CHANGE'
        ? new ApiError(409, 'NO_CHANGE', '이미 같은 상태입니다.')
        : new ApiError(409, 'INVALID_TRANSITION', '이 상태로 바꿀 수 없습니다.', { current: current.status });
    }
    const fields = toFields(current);
    if (change.needsOverlapCheck) {
      const slot = toSlot(fields);
      const clash = await occupyingRows(client, shopId, occupancyOf(slot), id);
      const [overlap] = appointmentWarnings(slot, NO_HOURS, clash, [], { excludeId: id, skipHoursCheck: true });
      if (overlap) throw staffOverlap(overlap.relatedIds);
    }
    await client.query('UPDATE crm.appointment_m1 SET status = $3 WHERE shop_id = $1 AND id = $2', [shopId, id, status]);
    return this.find(client, shopId, id);
  }

  async create(client: PoolClient, shopId: string, input: unknown): Promise<Appointment> {
    const { values } = readInput(input, false);
    const next = { menuId: null, prepMin: 0, memo: null, ...values } as Fields;
    // 업무 조회 전에 매장 쓰기 잠금 — 차단 등록과 순서를 맞춘다(Q3). 이후 조회는 먼저 커밋된 차단을 본다.
    await lockShopWrites(client, shopId);
    await checkReferences(client, shopId, next);
    await judge(client, shopId, next, { hours: true, overlap: true });
    // 메뉴 이름은 저장 시점의 이름을 남긴다(menu_name_snapshot, 015) — 메뉴 이름이 나중에 바뀌어도 예약 쪽은 그대로.
    const { rows: [row] } = await client.query<{ id: string }>(
      `INSERT INTO crm.appointment_m1
         (shop_id, customer_id, menu_id, staff_id, start_at, duration_min, cleanup_min, memo, menu_name_snapshot)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, (SELECT m.name FROM crm.menu m WHERE m.shop_id = $1 AND m.id = $3))
       RETURNING id`,
      [shopId, next.customerId, next.menuId, next.staffId, next.start, next.durationMin, next.prepMin, next.memo]);
    return this.find(client, shopId, row!.id);
  }

  /** 보낸 필드만 바꾼다. 상태는 /status(BEA-178)에서. */
  async update(client: PoolClient, shopId: string, id: string, input: unknown): Promise<Appointment> {
    if (!UUID.test(id)) throw appointmentNotFound();
    const { values, version } = readInput(input, true);
    await lockShopWrites(client, shopId);
    const { rows: [current] } = await client.query<StoredRow>(
      `SELECT customer_id, menu_id, staff_id, start_at, duration_min, cleanup_min, memo, status, version
         FROM crm.appointment_m1 WHERE shop_id = $1 AND id = $2 FOR UPDATE`, [shopId, id]);
    if (!current) throw appointmentNotFound();
    if (current.version !== version) throw versionConflict(current.version);
    const before = toFields(current);
    const after: Fields = { ...before, ...values };
    const changed = (KEYS as readonly (keyof Fields)[]).filter((k) => (k === 'start'
      ? after.start.getTime() !== before.start.getTime() : after[k] !== before[k]));
    if (changed.length === 0) return this.find(client, shopId, id);
    const has = (k: keyof Fields) => changed.includes(k);

    // D3: 바꾸는 참조만 확인한다 — 기존 예약의 비활성 고객·담당자는 그대로 둔 채 메모·시간을 고칠 수 있다.
    await checkReferences(client, shopId, {
      customerId: has('customerId') ? after.customerId : undefined,
      staffId: has('staffId') ? after.staffId : undefined,
      menuId: has('menuId') ? after.menuId : undefined,
    });
    // D2: 시술 시작이나 종료가 바뀌면 영업시간·휴무 재검사. Q1: 시작·시술·정리·담당자가 바뀌면 겹침·차단 재검사(점유 중인 상태만).
    // 메뉴·메모·고객만 바뀌면 재검사하지 않는다. 겹침 검사에서 자기 자신은 뺀다.
    const hours = has('start') || endOf(after) !== endOf(before);
    const overlap = OCCUPYING.has(current.status) && (['start', 'durationMin', 'prepMin', 'staffId'] as const).some(has);
    if (hours || overlap) await judge(client, shopId, after, { hours, overlap, excludeId: id });

    const columns = changed.map((k, i) => `${COLUMN[k]} = $${i + 3}`);
    if (has('menuId')) {
      columns.push(`menu_name_snapshot = (SELECT m.name FROM crm.menu m WHERE m.shop_id = $1 AND m.id = $${changed.indexOf('menuId') + 3})`);
    }
    await client.query(
      `UPDATE crm.appointment_m1 SET ${columns.join(', ')} WHERE shop_id = $1 AND id = $2`,
      [shopId, id, ...changed.map((k) => after[k])]);
    return this.find(client, shopId, id);
  }
}

async function judge(
  client: PoolClient, shopId: string, next: Fields, check: { hours: boolean; overlap: boolean; excludeId?: string },
): Promise<void> {
  const hours = check.hours ? await shopHours(client, shopId) : NO_HOURS;
  const slot = toSlot(next);
  const occupied = occupancyOf(slot);
  // 점유 구간에 걸리는 예약·활성 차단을 담당자 구분 없이 읽고, 담당자 조건(미지정은 누구와도)은 순수 함수가 거른다.
  const existing = check.overlap ? await occupyingRows(client, shopId, occupied, check.excludeId) : [];
  const blocks = check.overlap ? await activeBlocksIn(client, shopId, occupied) : [];
  const warnings = appointmentWarnings(slot, hours, existing, blocks, { excludeId: check.excludeId, skipHoursCheck: !check.hours });
  // ASSUMPTION(S3 단계 이행): 저장 응답에 warnings를 싣는 S3 서버 PR 전까지는 지금까지처럼 거부한다. 순서는 M1과 같다.
  const first = REJECT_ORDER.map((code) => warnings.find((w) => w.code === code)).find((w) => w !== undefined);
  if (first) throw bookingRejected(first);
}

const NO_HOURS: ShopHours = { businessHours: null, closures: [] };
const REJECT_ORDER: readonly WarningCode[] = ['CLOSED_DAY', 'OUTSIDE_BUSINESS_HOURS', 'OVERLAP_BLOCK', 'OVERLAP_APPOINTMENT'];

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
  client: PoolClient, shopId: string, refs: { customerId?: string; staffId?: string; menuId?: string | null },
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
const KEYS = ['customerId', 'menuId', 'staffId', 'start', 'durationMin', 'prepMin', 'memo'] as const;
type Fields = { customerId: string; menuId: string | null; staffId: string; start: Date; durationMin: number; prepMin: number; memo: string | null };
const COLUMN: Record<keyof Fields, string> = {
  customerId: 'customer_id', menuId: 'menu_id', staffId: 'staff_id', start: 'start_at',
  durationMin: 'duration_min', prepMin: 'cleanup_min', memo: 'memo',
};
const BODY_FIELDS = ['customerId', 'menuId', 'staffId', 'startAt', 'durationMin', 'prepMin', 'memo'];
export type FieldError = { field: string; code: string };
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// 시각은 offset을 꼭 붙인다(계약: ISO-8601+offset). offset 없는 시각은 서버 시간대에 따라 뜻이 달라진다.
const ISO = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

function readInput(input: unknown, patch: boolean): { values: Partial<Fields>; version: number | null } {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw invalid([{ field: '', code: 'INVALID_SHAPE' }]);
  const body = input as Record<string, unknown>;
  const errors: FieldError[] = [];
  const values: Partial<Fields> = {};
  const given = (k: string) => body[k] !== undefined;
  const need = (k: string) => { if (!patch) errors.push({ field: k, code: 'REQUIRED' }); };
  // 상태(status) 등 모르는 칸은 조용히 무시하지 않고 거부한다 — 바뀐 줄 알고 넘어가지 않게.
  for (const k of Object.keys(body)) if (!BODY_FIELDS.includes(k) && !(patch && k === 'version')) errors.push({ field: k, code: 'UNKNOWN_FIELD' });

  for (const k of ['customerId', 'staffId'] as const) {
    const v = body[k];
    if (!given(k)) need(k);
    else if (typeof v === 'string' && UUID.test(v)) values[k] = v.toLowerCase();
    else errors.push({ field: k, code: 'INVALID_ID' });
  }
  if (given('menuId')) {
    const v = body.menuId;
    if (v === null) values.menuId = null;
    else if (typeof v === 'string' && UUID.test(v)) values.menuId = v.toLowerCase();
    else errors.push({ field: 'menuId', code: 'INVALID_ID' });
  }
  if (!given('startAt')) need('startAt');
  else {
    const start = parseInstant(body.startAt);
    if (start) values.start = start;
    else errors.push({ field: 'startAt', code: 'INVALID_DATETIME' });
  }
  // 분 단위 정수. 시술 5~600, 정리 0~180(rev.3.1, DB CHECK 015와 같음).
  for (const [k, range] of [['durationMin', DURATION_RANGE], ['prepMin', CLEANUP_RANGE]] as const) {
    const v = body[k];
    if (!given(k)) { if (k === 'durationMin') need(k); }
    else if (typeof v === 'number' && minutesWithin(v, range)) values[k] = v;
    else errors.push({ field: k, code: 'INVALID_MINUTES' });
  }
  if (given('memo')) {
    const v = body.memo;
    if (v === null || typeof v === 'string') values.memo = typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
    else errors.push({ field: 'memo', code: 'INVALID_TYPE' });
  }
  let version: number | null = null;
  if (patch) {
    const v = body.version;
    if (typeof v === 'number' && Number.isInteger(v) && v >= 1) version = v;
    else errors.push({ field: 'version', code: v === undefined ? 'REQUIRED' : 'INVALID_VERSION' });
  }
  if (errors.length > 0) throw invalid(errors);
  return { values, version };
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
const VIEW_SELECT = `SELECT a.id, a.customer_id, a.menu_id, a.staff_id, a.start_at, a.duration_min, a.cleanup_min, a.memo, a.status,
              a.version, a.created_at, a.updated_at, c.name AS customer_name, m.name AS menu_name
         FROM crm.appointment_m1 a
         JOIN crm.customer c ON c.shop_id = a.shop_id AND c.id = a.customer_id
         LEFT JOIN crm.menu m ON m.shop_id = a.shop_id AND m.id = a.menu_id`;

export function versionConflict(currentVersion: number): ApiError<'VERSION_CONFLICT'> {
  return new ApiError(409, 'VERSION_CONFLICT', '다른 곳에서 먼저 고쳤습니다. 새로 불러와 주세요.', { currentVersion });
}
interface StoredRow {
  customer_id: string; menu_id: string | null; staff_id: string; start_at: Date; duration_min: number; cleanup_min: number;
  memo: string | null; status: AppointmentStatus; version: number;
}
interface ViewRow extends StoredRow { id: string; created_at: Date; updated_at: Date; customer_name: string; menu_name: string | null }

function toFields(r: StoredRow): Fields {
  return { customerId: r.customer_id, menuId: r.menu_id, staffId: r.staff_id, start: r.start_at, durationMin: r.duration_min, prepMin: r.cleanup_min, memo: r.memo };
}
function toSlot(f: Fields) {
  return { staffId: f.staffId, start: f.start, durationMin: f.durationMin, cleanupMin: f.prepMin };
}
function endOf(f: Fields): number {
  return f.start.getTime() + f.durationMin * 60_000;
}

function toAppointment(r: ViewRow, blockedBy: string[] = []): Appointment {
  return {
    id: r.id, customerId: r.customer_id, menuId: r.menu_id, staffId: r.staff_id, startAt: r.start_at.toISOString(),
    durationMin: r.duration_min, prepMin: r.cleanup_min, memo: r.memo, status: r.status, version: r.version,
    createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(),
    customerName: r.customer_name, menuName: r.menu_name, blockedBy,
  };
}

function bookingRejected(warning: BookingWarning): ApiError<string> {
  switch (warning.code) {
    case 'OVERLAP_APPOINTMENT': return staffOverlap(warning.relatedIds);
    case 'OUTSIDE_BUSINESS_HOURS': return new ApiError(422, warning.code, '영업시간 밖이라 저장할 수 없습니다.');
    case 'CLOSED_DAY': return new ApiError(422, warning.code, '휴무일이라 저장할 수 없습니다.');
    // 활성 차단과 겹침 — 충돌 id는 차단 UUID(09 §예약 저장 3).
    case 'OVERLAP_BLOCK': return new ApiError(409, 'BLOCKED', '관리 불가 시간과 겹칩니다.', { conflictingIds: warning.relatedIds });
  }
}

function staffOverlap(conflictingIds: string[]): ApiError<'STAFF_OVERLAP'> {
  return new ApiError(409, 'STAFF_OVERLAP', '같은 담당자의 다른 예약과 시간이 겹칩니다.', { conflictingIds });
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
