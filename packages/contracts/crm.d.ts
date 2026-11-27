// M1 CRM 계약 타입 — crm.openapi.yaml과 같은 모양. 웹(apps/web)과 서버(apps/server)가 같이 쓴다.
// yaml을 바꾸면 여기도 같이 바꾼다. 응답 타입은 모든 칸이 온다(값이 없으면 null) — yaml 응답 스키마의 required와 같다.

/** 고칠 수 있는 행의 공통 칸. version은 동시 수정 거부(409 VERSION_CONFLICT)에 쓴다. 올리는 건 DB 트리거(#43). */
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

/**
 * 예약 규칙(GET/PUT settings/appointment-rules, S3 rev.3.1 §3.2). 매장당 한 행.
 * ASSUMPTION: shop-info처럼 version 없이 통째로 바꾼다 — 설정 버전 저장 방식은 리더 확인 뒤 더한다.
 */
export interface AppointmentRules {
  /** 켜면 새 예약·시간·담당자 변경에서 담당자 필수. 기존 미지정 예약의 메모 수정은 허용. */
  requireStaffSelection: boolean;
}

export type ClosureInput =
  | { kind: 'weekly'; weekday: 1 | 2 | 3 | 4 | 5 | 6 | 7; note?: string | null }
  | { kind: 'holiday' | 'vacation'; startDate: string; endDate: string; note?: string | null };
export type Closure = ClosureInput & { id: string };

export interface MenuFields {
  name: string;
  /** 시술 5~600분. 밖이면 422 VALIDATION_FAILED */
  defaultDurationMin: number | null;
  /** 시술 뒤 정리 0~180분(rev.3.1) */
  defaultCleanupMin: number | null;
  /** 원 단위 정수, 0 이상. 등록에서 생략하면 0 */
  defaultPrice: number;
}
/** S3 전환 기간에만 쓰는 옛 이름 — defaultCleanupMin과 같은 값. 웹 전환(S3 ③) 뒤 지운다. */
interface LegacyMenuFields {
  /** @deprecated defaultCleanupMin을 쓴다 */
  defaultPrepMin: number | null;
}
export type MenuInput = Pick<MenuFields, 'name'> & Partial<Omit<MenuFields, 'name'> & LegacyMenuFields>;
export type MenuPatch = PatchOf<MenuFields & LegacyMenuFields & { active: boolean }>;
export interface Menu extends MenuFields, LegacyMenuFields, RowMeta {
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
/** created_source(manual·voice_task·onboarding)는 서버가 채우고 응답에 넣지 않는다. 웹 등록은 manual. */
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
  /** 비활성 고객도 후보에 넣고 active=false로 알린다 — 새로 등록하기 전에 되살리기를 권할 수 있게(S4). */
  candidates: { customerId: string; name: string; phone: string | null; hint: 'same_phone' | 'phone_missing' | 'different_phone'; active: boolean }[];
}

// ── 캘린더·예약 ──
export type AppointmentStatus = 'scheduled' | 'completed' | 'cancelled' | 'no_show' | 'voided';

export interface AppointmentFields {
  customerId: string;
  menuId: string | null;
  /** null = 담당자 미지정(등록에서 생략도 같음). 수정에서 생략은 그대로, null은 해제. */
  staffId: string | null;
  /** 시술 시작(ISO-8601+offset) */
  startAt: string;
  /** 시술 5~600분 */
  durationMin: number;
  /** 시술 뒤 정리 0~180분. 점유 = [startAt, startAt + durationMin + cleanupMin) */
  cleanupMin: number;
  memo: string | null;
}
/** S3 전환 기간에만 쓰는 옛 이름 — cleanupMin과 같은 값(요청에는 둘 중 하나만). 웹 전환(S3 ③) 뒤 지운다. */
interface LegacyAppointmentFields {
  /** @deprecated cleanupMin을 쓴다(뜻도 015부터 시술 뒤 정리 시간) */
  prepMin: number;
}
export type AppointmentInput = Pick<AppointmentFields, 'customerId' | 'startAt' | 'durationMin'> &
  Partial<Omit<AppointmentFields, 'customerId' | 'startAt' | 'durationMin'> & LegacyAppointmentFields>;
export type AppointmentPatch = PatchOf<AppointmentFields & LegacyAppointmentFields>;
export interface Appointment extends AppointmentFields, LegacyAppointmentFields, RowMeta {
  status: AppointmentStatus;
  customerName: string;
  /** 예약에 저장한 메뉴 이름(등록·메뉴 변경 때의 이름). 메뉴가 없으면 null */
  menuName: string | null;
  /** 이 예약과 겹치는 활성 차단 id(충돌 표시, AC-CRM-3). 미지정 예약은 모든 차단이 대상 */
  blockedBy: string[];
  /** 조회 시점에 점유가 겹치는 다른 점유 예약 id(같은 담당자이거나 한쪽이 미지정) */
  overlappingAppointmentIds: string[];
}

/** 저장 판정 경고(rev.3.1 §4.2). 순서: 예약 겹침 → 차단 겹침 → 영업시간 밖/휴무. */
export interface BookingWarning {
  code: 'OVERLAP_APPOINTMENT' | 'OVERLAP_BLOCK' | 'OUTSIDE_BUSINESS_HOURS' | 'CLOSED_DAY';
  /** 겹치는 예약·차단 id(같은 매장). 영업시간·휴무는 빈 배열 */
  relatedIds: string[];
}
/** 예약 쓰기(등록·수정·상태) 응답 = 예약 + 그 저장 시점의 경고(없으면 []). */
export interface AppointmentSaved extends Appointment {
  warnings: BookingWarning[];
}
/** POST appointments/preview-warnings — 새 예약(appointmentId 없음) 또는 기존 예약 수정(appointmentId·version + 바꿀 필드). */
export type AppointmentPreviewRequest =
  | (AppointmentInput & { appointmentId?: undefined })
  | (Partial<AppointmentFields & LegacyAppointmentFields> & { appointmentId: string; version: number });
export interface AppointmentPreviewResponse {
  warnings: BookingWarning[];
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
  /** 차단 테이블(BEA-179) 전까지는 항상 빈 배열 */
  blocks: CalendarBlock[];
}

/** CRM 쓰기 오류 코드(공통 코드에 더해). details에 개인정보를 넣지 않는다. */
export type CrmErrorCode =
  | 'VALIDATION_FAILED' // 422, details.fields: [{field, code}]
  | 'SETTINGS_INVALID' // 422, details: {reason, at}
  | 'VERSION_CONFLICT' // 409, details: {currentVersion}
  | 'NO_CHANGE' // 409
  | 'INVALID_TRANSITION' // 409
  // S3 rev.3.1부터 예약 쓰기는 아래 네 코드로 거부하지 않는다(warnings로 알림). 웹 전환(S3 ③) 뒤 지운다.
  | 'STAFF_OVERLAP'
  | 'BLOCKED'
  | 'OUTSIDE_BUSINESS_HOURS'
  | 'CLOSED_DAY'
  | 'INVALID_RANGE'; // 400
