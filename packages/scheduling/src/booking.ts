// 예약 저장 검사 — BEA-177 (명세 3 기능 2A-3.4·2A-3.6·2A-3.7, 명세 1 §2.2). 외부 의존성 없는 순수 함수.
// 2026-11-19 명세 최종판 기준. 11/18 규칙(매장 최대 2건·자리·그대로 저장·세션 뒤 준비 시간)을 담은 conflict.ts를 대체한다.
// - 점유 구간 = [관리 시작 − 준비, 관리 시작 + 관리) — 준비 시간은 관리 앞에 붙는다 [결정 R33].
// - 같은 담당자의 점유 구간은 겹칠 수 없고, 다른 담당자는 같은 시각에 받을 수 있다 [결정 R12]. 강제 저장은 없다.
// - 완료·노쇼는 점유를 유지하고 취소·무효만 빠진다.
// - 영업시간 밖·휴무일은 거부한다. 영업시간은 관리 구간만 비교한다(준비 시간은 영업 시작 전에 걸쳐도 됨).
//   영업시간을 넣지 않은 매장은 영업시간 검사를 하지 않고 휴무만 검사한다. 되돌리기 복원은 이 검사를 건너뛴다 [결정 S2].
// - 활성 차단(담당자별 또는 매장 전체)과 점유 구간이 겹치는 생성·이동은 거부한다. 차단을 새로 만들어도
//   기존 예약은 막지 않고 충돌로 표시만 한다 [결정 R50].
// DB에도 같은 담당자 겹침 배타 제약이 최종 방어선으로 있다(2F 스키마). 이 함수는 저장 전에 이유와 함께 거절하려는 것이다.
// 2A는 서울 시간대만 지원한다(#19 리뷰 리더 결정). 서울은 UTC+9 고정이다.

import { OCCUPYING, type AppointmentStatus } from "./appointment-status.ts";

export interface Interval {
  start: Date;
  end: Date;
}

export interface BookingRequest {
  staffId: string;
  /** 관리 시작. */
  start: Date;
  /** 관리 시간(분, 1 이상 정수). */
  durationMin: number;
  /** 관리 전 준비 시간(분, 0 이상 정수). */
  prepMin: number;
}

export interface ExistingBooking {
  id: string;
  staffId: string;
  status: AppointmentStatus;
  occupied: Interval;
}

export interface ActiveBlock {
  id: string;
  start: Date;
  end: Date;
  /** 매장 전체(이후 추가되는 담당자 포함). */
  allStaff: boolean;
  staffIds: string[];
}

/** 서울 시각 "HH:MM". "24:00"은 다음 날 0시. */
export interface OpenWindow {
  open: string;
  close: string;
}

/**
 * ASSUMPTION: `shop_settings.business_hours`(jsonb) 형식은 명세가 정하지 않았다(개발팀 위임).
 * 요일(1=월 … 7=일, shop_closure.weekday와 같은 번호)별 영업 구간 목록으로 둔다. 키가 없는 요일은 영업하지 않는 날이다.
 */
export type BusinessHours = Partial<Record<1 | 2 | 3 | 4 | 5 | 6 | 7, OpenWindow[]>>;

/** shop_closure 한 행. 요일 휴무 또는 날짜 구간(시작·끝 포함, 서울 날짜 "YYYY-MM-DD"). */
export type Closure =
  | { kind: "weekly"; weekday: 1 | 2 | 3 | 4 | 5 | 6 | 7 }
  | { kind: "holiday" | "vacation"; startDate: string; endDate: string };

export interface ShopHours {
  /** 넣지 않았으면 null — 영업시간 검사를 하지 않는다. */
  businessHours: BusinessHours | null;
  closures: Closure[];
}

export interface CheckOptions {
  /** 시간을 옮기는 예약 자신. 겹침 검사에서 뺀다. */
  excludeId?: string;
  /** 되돌리기가 이전 값으로 복원할 때만 true — 영업시간·휴무 검사를 건너뛴다(겹침·차단은 검사). */
  skipHoursCheck?: boolean;
}

export type BookingReject =
  | "INVALID_PERIOD"
  | "STAFF_REQUIRED"
  | "CLOSED_DAY"
  | "OUTSIDE_BUSINESS_HOURS"
  | "BLOCKED"
  | "STAFF_OVERLAP";

export type BookingCheck =
  | { ok: true; occupied: Interval }
  | {
      ok: false;
      reason: BookingReject;
      /** BLOCKED면 차단 id, STAFF_OVERLAP이면 겹친 예약 id. */
      conflictingIds: string[];
    };

const MINUTE = 60_000;
const SEOUL_OFFSET_MS = 9 * 3_600_000;

export function overlaps(a: Interval, b: Interval): boolean {
  return a.start.getTime() < b.end.getTime() && b.start.getTime() < a.end.getTime();
}

/** 점유 구간 [시작 − 준비, 시작 + 관리). */
export function occupiedOf(r: Pick<BookingRequest, "start" | "durationMin" | "prepMin">): Interval {
  return {
    start: new Date(r.start.getTime() - r.prepMin * MINUTE),
    end: new Date(r.start.getTime() + r.durationMin * MINUTE),
  };
}

/** 관리 구간 [시작, 시작 + 관리). 영업시간은 이 구간으로 비교한다. */
export function sessionOf(r: Pick<BookingRequest, "start" | "durationMin">): Interval {
  return { start: r.start, end: new Date(r.start.getTime() + r.durationMin * MINUTE) };
}

/**
 * 분 값의 저장 상한 = PostgreSQL `integer` 최댓값. 예약의 `duration_min`·`prep_min`과 메뉴 기본 시간 컬럼이
 * `integer`라 이보다 크면 저장 시 서버 오류가 나고, 날짜 계산이 유효 범위를 넘을 수도 있다(#36·#39 리뷰).
 * 업무상 상한은 두지 않는다(설계 노트 Q4).
 */
export const MAX_MINUTES = 2_147_483_647;

/** min 이상 MAX_MINUTES 이하의 정수인지. */
export function minutesIn(value: number, min: number): boolean {
  return Number.isInteger(value) && value >= min && value <= MAX_MINUTES;
}

/**
 * 예약을 이 시간·담당자로 저장(생성·이동)할 수 있는지 판정한다.
 * 호출 규약 — 예약 쓰기 함수(BEA-176)가 지킨다:
 * - `existing`·`blocks`에는 **같은 매장**의 행만 넘긴다(절대 규칙 5). 상태는 걸러서 넘기지 않아도 된다(여기서 거른다).
 * - `blocks`에는 활성(`active`) 차단만 넘긴다.
 * - 매장 범위 트랜잭션 안에서 저장 직전에 다시 부르고, 최종 보장은 DB 배타 제약에 맡긴다.
 */
export function checkBooking(
  request: BookingRequest,
  hours: ShopHours,
  existing: readonly ExistingBooking[],
  blocks: readonly ActiveBlock[],
  options: CheckOptions = {},
): BookingCheck {
  if (!request.staffId) return reject("STAFF_REQUIRED");
  if (
    Number.isNaN(request.start.getTime()) ||
    !minutesIn(request.durationMin, 1) ||
    !minutesIn(request.prepMin, 0)
  ) {
    return reject("INVALID_PERIOD");
  }

  if (!options.skipHoursCheck) {
    const hoursReject = checkHours(sessionOf(request), hours);
    if (hoursReject) return reject(hoursReject);
  }

  const occupied = occupiedOf(request);
  const blocking = blocks.filter(
    (b) => (b.allStaff || b.staffIds.includes(request.staffId)) && overlaps(b, occupied),
  );
  if (blocking.length > 0) return reject("BLOCKED", blocking.map((b) => b.id));

  const overlapping = existing.filter(
    (e) =>
      e.id !== options.excludeId &&
      e.staffId === request.staffId &&
      OCCUPYING.has(e.status) &&
      overlaps(e.occupied, occupied),
  );
  if (overlapping.length > 0) return reject("STAFF_OVERLAP", overlapping.map((e) => e.id));

  return { ok: true, occupied };
}

/** 차단과 겹쳐 "충돌"로 표시할 기존 예약 id(차단 대상 담당자의 점유 예약만). 차단 생성은 이 예약들을 막지 않는다. */
export function blockedAppointmentIds(block: ActiveBlock, appointments: readonly ExistingBooking[]): string[] {
  return appointments
    .filter(
      (a) =>
        OCCUPYING.has(a.status) &&
        (block.allStaff || block.staffIds.includes(a.staffId)) &&
        overlaps(block, a.occupied),
    )
    .map((a) => a.id);
}

function checkHours(session: Interval, hours: ShopHours): BookingReject | null {
  const local = toSeoul(session.start);
  // 휴무는 관리가 걸치는 **모든** 날(서울)로 판정한다. 영업시간을 넣지 않은 매장에서 여러 날에 걸친 관리가
  // 사이에 낀 휴무일을 지나는 경우도 막는다(#36 리뷰 2회). 영업시간이 있으면 자정을 넘는 관리는 아래에서 어차피 거부된다.
  const lastDay = toSeoul(new Date(session.end.getTime() - 1));
  if (hours.closures.some((c) => closedWithin(c, local, lastDay))) return "CLOSED_DAY";
  if (hours.businessHours === null) return null;

  const windows = hours.businessHours[local.weekday] ?? [];
  if (windows.length === 0) return "CLOSED_DAY";
  // 관리 구간 전체가 시작일(서울)의 영업 구간 하나 안에 있어야 한다. 자정을 넘는 관리는 영업시간 밖이다.
  // 맞닿은 구간(10:00–13:00, 13:00–18:00)은 쉬는 틈이 없으므로 이어 붙여 한 구간으로 본다(#55 리뷰).
  // 실제 휴게 공백이 있으면 따로 남아, 공백에 걸친 관리는 계속 거부된다.
  const inside = mergeTouching(windows.map((w) => ({
    open: seoulTimeToInstant(local.date, w.open),
    close: seoulTimeToInstant(local.date, w.close),
  }))).some((w) => session.start.getTime() >= w.open && session.end.getTime() <= w.close);
  return inside ? null : "OUTSIDE_BUSINESS_HOURS";
}

/** 시작 순으로 정렬해 끝 = 다음 시작(또는 겹침)인 구간을 하나로 합친다. */
function mergeTouching(windows: { open: number; close: number }[]): { open: number; close: number }[] {
  const merged: { open: number; close: number }[] = [];
  for (const w of [...windows].sort((a, b) => a.open - b.open)) {
    const last = merged[merged.length - 1];
    if (last && w.open <= last.close) last.close = Math.max(last.close, w.close);
    else merged.push({ ...w });
  }
  return merged;
}

type SeoulDay = { date: string; weekday: number };

/**
 * 서울 날짜 first~last(양끝 포함) 중 하루라도 이 휴무에 걸리는지.
 * 관리 시간에 상한이 없어(설계 노트 Q4) 날짜를 하나씩 돌지 않는다: 기간 휴무는 구간 겹침으로,
 * 매주 휴무는 7일 이상이면 반드시 걸리고 그보다 짧으면 요일만 센다.
 */
function closedWithin(c: Closure, first: SeoulDay, last: SeoulDay): boolean {
  if (c.kind !== "weekly") return c.startDate <= last.date && first.date <= c.endDate;
  const days = Math.round((Date.parse(last.date) - Date.parse(first.date)) / 86_400_000) + 1;
  if (days >= 7) return true;
  for (let i = 0; i < days; i++) {
    if (((first.weekday - 1 + i) % 7) + 1 === c.weekday) return true;
  }
  return false;
}

function reject(reason: BookingReject, conflictingIds: string[] = []): BookingCheck {
  return { ok: false, reason, conflictingIds };
}

/** UTC 시각의 서울 날짜("YYYY-MM-DD")와 요일(1=월 … 7=일). */
export function toSeoul(at: Date): { date: string; weekday: 1 | 2 | 3 | 4 | 5 | 6 | 7 } {
  const shifted = new Date(at.getTime() + SEOUL_OFFSET_MS);
  const day = shifted.getUTCDay(); // 0=일
  return { date: shifted.toISOString().slice(0, 10), weekday: (day === 0 ? 7 : day) as 1 | 2 | 3 | 4 | 5 | 6 | 7 };
}

/** 서울 날짜 + "HH:MM"을 실제 시각(epoch ms)으로. "24:00"은 다음 날 0시. */
export function seoulTimeToInstant(date: string, hhmm: string): number {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = hhmm.split(":").map(Number);
  return Date.UTC(y!, mo! - 1, d!, h!, mi!) - SEOUL_OFFSET_MS;
}
