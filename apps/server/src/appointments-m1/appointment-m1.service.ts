import type { Appointment, AppointmentStatus } from '@bv/contracts';
import { OCCUPYING } from '@bv/scheduling/appointment-status';
import { type BookingReject, checkBooking, type Closure, type ExistingBooking, type Interval, minutesIn, occupiedOf, type ShopHours } from '@bv/scheduling/booking';
import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApiError } from '../common/api-error';
import type { DatabaseService } from '../database.service';

// M1 예약 쓰기(BEA-176·160) — `crm.appointment_m1`만 쓴다. 006 `crm.appointment`(옛 C-07 서비스, src/appointments)는
// 이행 합의 전까지 건드리지 않는다. 모든 함수는 DatabaseService.withShop 트랜잭션의 client를 받고,
// RLS와 별개로 쿼리마다 shop_id 조건을 쓴다(절대 규칙 5). 판정은 @bv/scheduling/booking(#36) — 최종 겹침 판정은 DB 제약.
@Injectable()
export class AppointmentM1Service {
  async find(client: PoolClient, shopId: string, id: string): Promise<Appointment> {
    if (!UUID.test(id)) throw appointmentNotFound();
    const { rows: [row] } = await client.query<ViewRow>(
      `SELECT a.id, a.customer_id, a.menu_id, a.staff_id, a.start_at, a.duration_min, a.prep_min, a.memo, a.status,
              a.version, a.created_at, a.updated_at, c.name AS customer_name, m.name AS menu_name
         FROM crm.appointment_m1 a
         JOIN crm.customer c ON c.shop_id = a.shop_id AND c.id = a.customer_id
         LEFT JOIN crm.menu m ON m.shop_id = a.shop_id AND m.id = a.menu_id
        WHERE a.shop_id = $1 AND a.id = $2`, [shopId, id]);
    if (!row) throw appointmentNotFound();
    return toAppointment(row);
  }

  async create(client: PoolClient, shopId: string, input: unknown): Promise<Appointment> {
    const { values } = readInput(input, false);
    const next = { menuId: null, prepMin: 0, memo: null, ...values } as Fields;
    await checkReferences(client, shopId, next);
    await judge(client, shopId, next, { hours: true, overlap: true });
    const { rows: [row] } = await rejectOverlapRace(next, undefined, () => client.query<{ id: string }>(
      `INSERT INTO crm.appointment_m1 (shop_id, customer_id, menu_id, staff_id, start_at, duration_min, prep_min, memo)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [shopId, next.customerId, next.menuId, next.staffId, next.start, next.durationMin, next.prepMin, next.memo]));
    return this.find(client, shopId, row!.id);
  }

  /** 보낸 필드만 바꾼다. 상태는 /status(BEA-178)에서. */
  async update(client: PoolClient, shopId: string, id: string, input: unknown): Promise<Appointment> {
    if (!UUID.test(id)) throw appointmentNotFound();
    const { values, version } = readInput(input, true);
    const { rows: [current] } = await client.query<StoredRow>(
      `SELECT customer_id, menu_id, staff_id, start_at, duration_min, prep_min, memo, status, version
         FROM crm.appointment_m1 WHERE shop_id = $1 AND id = $2 FOR UPDATE`, [shopId, id]);
    if (!current) throw appointmentNotFound();
    if (current.version !== version) {
      throw new ApiError(409, 'VERSION_CONFLICT', '다른 곳에서 먼저 고쳤습니다. 새로 불러와 주세요.', { currentVersion: current.version });
    }
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
    // D2: 관리 시작이나 종료가 바뀌면 영업시간·휴무 재검사. Q1: 시작·관리·준비·담당자가 바뀌면 겹침 재검사(점유 중인 상태만).
    // 메뉴·메모·고객만 바뀌면 재검사하지 않는다. 겹침 검사에서 자기 자신은 뺀다.
    const hours = has('start') || endOf(after) !== endOf(before);
    const overlap = OCCUPYING.has(current.status) && (['start', 'durationMin', 'prepMin', 'staffId'] as const).some(has);
    if (hours || overlap) await judge(client, shopId, after, { hours, overlap, excludeId: id });

    const columns = changed.map((k, i) => `${COLUMN[k]} = $${i + 3}`);
    await rejectOverlapRace(after, id, () => client.query(
      `UPDATE crm.appointment_m1 SET ${columns.join(', ')} WHERE shop_id = $1 AND id = $2`,
      [shopId, id, ...changed.map((k) => after[k])]));
    return this.find(client, shopId, id);
  }
}

/**
 * 동시 저장으로 DB 겹침 제약(23P01)에 걸린 쓰기를 409 STAFF_OVERLAP으로 바꾼다.
 * 제약 오류로 트랜잭션이 깨지면 같은 트랜잭션에서 선점한 Idempotency-Key 행도 함께 롤백된다 → 409는 저장·재생하지 않고,
 * 같은 키로 다시 보내면 다시 판정한다. 충돌 id는 롤백 뒤 **새 매장 범위 트랜잭션**에서 같은 매장 행만 찾아 채운다.
 */
export async function withOverlapIds<T>(database: DatabaseService, shopId: string, write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (!(error instanceof StaffOverlapRace)) throw error;
    const ids = await database.withShop(shopId, async (client) =>
      (await occupyingRows(client, shopId, error.staffId, error.occupied, error.excludeId)).map((r) => r.id));
    throw staffOverlap(ids);
  }
}

class StaffOverlapRace extends Error {
  constructor(readonly staffId: string, readonly occupied: Interval, readonly excludeId: string | undefined) {
    super('appointment_m1_staff_overlap');
  }
}

async function rejectOverlapRace<T>(next: Fields, excludeId: string | undefined, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const pg = error as { code?: string; constraint?: string };
    if (pg.code === '23P01' && pg.constraint === 'appointment_m1_staff_overlap') {
      throw new StaffOverlapRace(next.staffId, occupiedOf(toRequest(next)), excludeId);
    }
    throw error;
  }
}

async function judge(
  client: PoolClient, shopId: string, next: Fields, check: { hours: boolean; overlap: boolean; excludeId?: string },
): Promise<void> {
  const hours = check.hours ? await shopHours(client, shopId) : { businessHours: null, closures: [] };
  const existing = check.overlap ? await occupyingRows(client, shopId, next.staffId, occupiedOf(toRequest(next)), check.excludeId) : [];
  // 차단은 BEA-179 전까지 없다(빈 배열).
  const result = checkBooking(toRequest(next), hours, existing, [], { excludeId: check.excludeId, skipHoursCheck: !check.hours });
  if (!result.ok) throw bookingRejected(result.reason, result.conflictingIds);
}

async function occupyingRows(
  client: PoolClient, shopId: string, staffId: string, occupied: Interval, excludeId: string | undefined,
): Promise<ExistingBooking[]> {
  const { rows } = await client.query<{ id: string; status: AppointmentStatus; start: Date; end: Date }>(
    `SELECT id, status, lower(occupied) AS start, upper(occupied) AS "end" FROM crm.appointment_m1
      WHERE shop_id = $1 AND staff_id = $2 AND status NOT IN ('cancelled', 'voided')
        AND occupied && tstzrange($3, $4, '[)') AND id IS DISTINCT FROM $5::uuid
      ORDER BY start_at, id`,
    [shopId, staffId, occupied.start, occupied.end, excludeId ?? null]);
  return rows.map((r) => ({ id: r.id, staffId, status: r.status, occupied: { start: r.start, end: r.end } }));
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
  durationMin: 'duration_min', prepMin: 'prep_min', memo: 'memo',
};
const BODY_FIELDS = ['customerId', 'menuId', 'staffId', 'startAt', 'durationMin', 'prepMin', 'memo'];
type FieldError = { field: string; code: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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
  // 분 단위 정수. 관리 ≥ 1, 준비 ≥ 0, 상한은 DB integer(설계 Q4).
  for (const [k, min] of [['durationMin', 1], ['prepMin', 0]] as const) {
    const v = body[k];
    if (!given(k)) { if (k === 'durationMin') need(k); }
    else if (typeof v === 'number' && minutesIn(v, min)) values[k] = v;
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

function parseInstant(value: unknown): Date | null {
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

// ── 출력·오류 ──
interface StoredRow {
  customer_id: string; menu_id: string | null; staff_id: string; start_at: Date; duration_min: number; prep_min: number;
  memo: string | null; status: AppointmentStatus; version: number;
}
interface ViewRow extends StoredRow { id: string; created_at: Date; updated_at: Date; customer_name: string; menu_name: string | null }

function toFields(r: StoredRow): Fields {
  return { customerId: r.customer_id, menuId: r.menu_id, staffId: r.staff_id, start: r.start_at, durationMin: r.duration_min, prepMin: r.prep_min, memo: r.memo };
}
function toRequest(f: Fields) {
  return { staffId: f.staffId, start: f.start, durationMin: f.durationMin, prepMin: f.prepMin };
}
function endOf(f: Fields): number {
  return f.start.getTime() + f.durationMin * 60_000;
}

function toAppointment(r: ViewRow): Appointment {
  return {
    id: r.id, customerId: r.customer_id, menuId: r.menu_id, staffId: r.staff_id, startAt: r.start_at.toISOString(),
    durationMin: r.duration_min, prepMin: r.prep_min, memo: r.memo, status: r.status, version: r.version,
    createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(),
    customerName: r.customer_name, menuName: r.menu_name, blockedBy: [],
  };
}

function bookingRejected(reason: BookingReject, conflictingIds: string[]): ApiError<string> {
  switch (reason) {
    case 'STAFF_OVERLAP': return staffOverlap(conflictingIds);
    case 'OUTSIDE_BUSINESS_HOURS': return new ApiError(422, reason, '영업시간 밖이라 저장할 수 없습니다.');
    case 'CLOSED_DAY': return new ApiError(422, reason, '휴무일이라 저장할 수 없습니다.');
    // 차단(BLOCKED)은 BEA-179 전까지 생기지 않는다. 형식 오류는 입력 검사에서 먼저 걸러진다.
    default: return new ApiError(422, 'VALIDATION_FAILED', '입력값을 확인해 주세요.', { reason });
  }
}

function staffOverlap(conflictingIds: string[]): ApiError<'STAFF_OVERLAP'> {
  return new ApiError(409, 'STAFF_OVERLAP', '같은 담당자의 다른 예약과 시간이 겹칩니다.', { conflictingIds });
}

function invalid(fields: FieldError[]): ApiError<'VALIDATION_FAILED'> {
  return new ApiError(422, 'VALIDATION_FAILED', '입력값을 확인해 주세요.', { fields });
}

function appointmentNotFound(): ApiError<'NOT_FOUND'> {
  return new ApiError(404, 'NOT_FOUND', '예약을 찾을 수 없습니다.');
}
