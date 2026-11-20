// M1 CRM 계약 타입 — crm.openapi.yaml과 같은 모양. 웹(apps/web)과 서버(apps/server)가 같이 쓴다.
// yaml을 바꾸면 여기도 같이 바꾼다. 응답 타입은 모든 칸이 온다(값이 없으면 null) — yaml 응답 스키마의 required와 같다.

/** 고칠 수 있는 행의 공통 칸. version은 동시 수정 거부(409 VERSION_CONFLICT)에 쓴다. */
export interface RowMeta {
  id: string;
  version: number;
  /** ISO-8601 */
  createdAt: string;
  updatedAt: string;
}

/** 수정 요청: 보낸 필드만 바뀐다(null은 비우기). version만 필수. */
export type PatchOf<T> = Partial<T> & { version: number };

// ── 설정 ──
export interface OpenWindow {
  /** 서울 시각 "HH:MM" */
  open: string;
  /** "HH:MM" 또는 "24:00" */
  close: string;
}
/** 요일 '1'(월)~'7'(일). 키가 없는 요일은 영업하지 않음. */
export type BusinessHours = Partial<Record<'1' | '2' | '3' | '4' | '5' | '6' | '7', OpenWindow[]>>;
export interface BusinessHoursBody {
  /** null = 아직 넣지 않음 → 예약 저장 때 영업시간 검사 안 함 */
  businessHours: BusinessHours | null;
}

/**
 * 매장 안내 정보(shop_settings, BEA-166). GET 응답·PUT 본문이 같은 모양이고 모든 칸이 온다(없으면 null).
 * 매장당 한 행이라 version 없이 통째로 바꾼다. 링크는 http·https만(ASSUMPTION).
 */
export interface ShopInfo {
  refundPolicy: string | null;
  naverPlaceUrl: string | null;
  instagramUrl: string | null;
  landingUrl: string | null;
  locationText: string | null;
}

export type ClosureInput =
  | { kind: 'weekly'; weekday: 1 | 2 | 3 | 4 | 5 | 6 | 7; note?: string | null }
  | { kind: 'holiday' | 'vacation'; startDate: string; endDate: string; note?: string | null };
export type Closure = ClosureInput & { id: string };

export interface MenuFields {
  name: string;
  defaultDurationMin: number | null;
  defaultPrepMin: number | null;
}
export type MenuInput = Pick<MenuFields, 'name'> & Partial<Omit<MenuFields, 'name'>>;
export type MenuPatch = PatchOf<MenuFields & { active: boolean }>;
export interface Menu extends MenuFields, RowMeta {
  active: boolean;
}

export interface Staff extends RowMeta {
  name: string;
  active: boolean;
}
export type StaffPatch = PatchOf<{ name: string; active: boolean }>;

// ── 고객 ──
export interface CustomerFields {
  name: string;
  /** 숫자만(예 01000000001). 표시 하이픈은 화면이 붙인다. */
  phone: string | null;
  /** 특이사항(customer.notes) */
  memo: string | null;
  /** YYYY-MM-DD */
  birthdate: string | null;
  address: string | null;
}
export type CustomerInput = Pick<CustomerFields, 'name'> & Partial<Omit<CustomerFields, 'name'>>;
export type CustomerPatch = PatchOf<CustomerFields>;
export interface Customer extends CustomerFields, RowMeta {
  active: boolean;
  deactivatedAt: string | null;
}
export interface CustomerActiveBody {
  version: number;
  active: boolean;
}
export interface SameNameCheckRequest {
  name: string;
  phone?: string | null;
  /** 수정 중인 고객 자신은 후보에서 뺀다. */
  excludeId?: string;
}
export interface SameNameCheckResponse {
  needsReview: boolean;
  candidates: { customerId: string; name: string; phone: string | null; hint: 'same_phone' | 'phone_missing' | 'different_phone' }[];
}

// ── 캘린더·예약 ──
export type AppointmentStatus = 'scheduled' | 'completed' | 'cancelled' | 'no_show' | 'voided';

export interface AppointmentFields {
  customerId: string;
  menuId: string | null;
  staffId: string;
  /** 관리 시작(ISO-8601+offset) */
  startAt: string;
  durationMin: number;
  /** 관리 앞 준비 시간. 점유 = [startAt − prepMin, startAt + durationMin) */
  prepMin: number;
  memo: string | null;
}
export type AppointmentInput = Pick<AppointmentFields, 'customerId' | 'staffId' | 'startAt' | 'durationMin'> &
  Partial<Omit<AppointmentFields, 'customerId' | 'staffId' | 'startAt' | 'durationMin'>>;
export type AppointmentPatch = PatchOf<AppointmentFields>;
export interface Appointment extends AppointmentFields, RowMeta {
  status: AppointmentStatus;
  customerName: string;
  menuName: string | null;
  /** 이 예약과 겹치는 활성 차단 id(충돌 표시, AC-CRM-3) */
  blockedBy: string[];
}
export interface AppointmentStatusBody {
  version: number;
  /** voided는 되돌리기 전용이라 고를 수 없다. */
  status: Exclude<AppointmentStatus, 'voided'>;
}

export interface CalendarBlockFields {
  startAt: string;
  endAt: string;
  /** true면 매장 전체(이후 추가되는 담당자 포함) */
  allStaff: boolean;
  /** allStaff=false일 때 1명 이상 */
  staffIds: string[];
  memo: string | null;
}
export type CalendarBlockInput = Omit<CalendarBlockFields, 'memo'> & { memo?: string | null };
export type CalendarBlockPatch = PatchOf<CalendarBlockFields>;
export interface CalendarBlock extends CalendarBlockFields, RowMeta {}

/** GET /calendar?from&to — from~to는 매장 날짜, 마지막 날 포함, 최대 42일 */
export interface CalendarResponse {
  staff: Staff[];
  appointments: Appointment[];
  blocks: CalendarBlock[];
}

/** CRM 쓰기 오류 코드(공통 코드에 더해). details에 개인정보를 넣지 않는다. */
export type CrmErrorCode =
  | 'VALIDATION_FAILED' // 422, details.fields: [{field, code}]
  | 'SETTINGS_INVALID' // 422, details: {reason, at}
  | 'VERSION_CONFLICT' // 409, details: {currentVersion}
  | 'NO_CHANGE' // 409
  | 'INVALID_TRANSITION' // 409
  | 'STAFF_OVERLAP' // 409, details.conflictingIds — DB 23P01도 이 코드로
  | 'BLOCKED' // 409, details.conflictingIds
  | 'OUTSIDE_BUSINESS_HOURS' // 422
  | 'CLOSED_DAY' // 422
  | 'INVALID_RANGE'; // 400
