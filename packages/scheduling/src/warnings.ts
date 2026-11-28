// 예약 경고 판정 — S3 캘린더 rev.3.1(명세 §4.2). 외부 의존성 없는 순수 함수. booking.ts의 checkBooking(거부)을 대체한다.
// - 웹 수동 저장은 겹침·차단·영업시간 밖·휴무를 거부하지 않는다. 이 함수는 경고 목록만 돌려주고, 저장할지는 호출한 쪽이 정한다
//   (웹은 경고와 함께 저장, AI는 예약·차단 겹침이면 확인 카드 — ADR-0002).
// - 점유 = [시작, 시작 + 시술 + 정리) — 정리 시간은 시술 뒤에 붙는다. DB 015 트리거와 같은 식이다.
// - 구간은 반열린 구간이다. 한쪽의 끝과 다른 쪽의 시작이 같으면 겹치지 않는다.
// - 담당자 미지정(null) 예약은 누구와도 겹친다. 지정된 담당자끼리는 같은 담당자일 때만 겹친다.
// - 차단은 매장 전체 차단과 그 담당자 차단이 대상이다. 미지정 예약은 시간대가 겹치는 모든 활성 차단이 대상이다.
// - 영업시간·휴무는 시술 구간으로 본다(정리 시간은 넣지 않음 — M1 규칙 유지, ASSUMPTION: PM 확인 전).
// - 취소·무효 예약은 점유하지 않는다.

import { OCCUPYING, type AppointmentStatus } from "./appointment-status.ts";
import { checkHours, overlaps, sessionOf, type ActiveBlock, type Interval, type ShopHours } from "./booking.ts";

/** 시술 시간(분) 범위. DB CHECK(015)와 같다. */
export const DURATION_RANGE = { min: 5, max: 600 } as const;
/** 정리 시간(분) 범위. DB CHECK(015)와 같다. */
export const CLEANUP_RANGE = { min: 0, max: 180 } as const;

/** 범위 안의 정수인지(양 끝 포함). */
export function minutesWithin(value: number, range: { min: number; max: number }): boolean {
  return Number.isInteger(value) && value >= range.min && value <= range.max;
}

export interface AppointmentSlot {
  /** null = 담당자 미지정. */
  staffId: string | null;
  /** 시술 시작. */
  start: Date;
  durationMin: number;
  /** 시술 뒤 정리 시간. */
  cleanupMin: number;
}

export interface OccupyingAppointment {
  id: string;
  staffId: string | null;
  status: AppointmentStatus;
  occupied: Interval;
}

export type WarningCode = "OVERLAP_APPOINTMENT" | "OVERLAP_BLOCK" | "OUTSIDE_BUSINESS_HOURS" | "CLOSED_DAY";

export interface BookingWarning {
  code: WarningCode;
  /** 겹치는 예약 id 또는 차단 id(넘겨받은 순서). 영업시간·휴무는 빈 배열. */
  relatedIds: string[];
}

export interface WarningOptions {
  /** 고치는 예약 자신. 겹침에서 뺀다. */
  excludeId?: string;
  /** 영업시간·휴무를 보지 않는다(시작·끝이 그대로인 수정, 취소 되살리기). */
  skipHoursCheck?: boolean;
}

/** 점유 구간 [시작, 시작 + 시술 + 정리). */
export function occupancyOf(slot: Pick<AppointmentSlot, "start" | "durationMin" | "cleanupMin">): Interval {
  return { start: slot.start, end: new Date(slot.start.getTime() + (slot.durationMin + slot.cleanupMin) * 60_000) };
}

/** 두 담당자 값이 같은 자원을 다투는지. 한쪽이라도 미지정이면 다툰다. */
export function staffContends(a: string | null, b: string | null): boolean {
  return a === null || b === null || a === b;
}

/** 이 차단이 이 담당자(미지정이면 누구든)에게 걸리는지. */
export function blockApplies(block: Pick<ActiveBlock, "allStaff" | "staffIds">, staffId: string | null): boolean {
  return staffId === null || block.allStaff || block.staffIds.includes(staffId);
}

/**
 * 이 시간·담당자로 저장할 때의 경고 목록. 경고 순서는 예약 겹침 → 차단 겹침 → 영업시간 밖/휴무로 고정이다.
 * 호출 규약:
 * - 입력 형식(시각·분 범위)은 먼저 검사해 둔다. 범위 밖 값이 오면 RangeError — 프로그램 오류다.
 * - `existing`·`blocks`에는 **같은 매장** 행만 넘긴다(절대 규칙 5). `blocks`는 활성 차단만. 상태·담당자는 여기서 거른다.
 * - 저장 판정은 매장 쓰기 잠금 안에서 최신 행으로 다시 부른다(미리 보기 결과는 저장 시점까지 보장되지 않는다).
 */
export function appointmentWarnings(
  slot: AppointmentSlot,
  hours: ShopHours,
  existing: readonly OccupyingAppointment[],
  blocks: readonly ActiveBlock[],
  options: WarningOptions = {},
): BookingWarning[] {
  if (
    Number.isNaN(slot.start.getTime()) ||
    !minutesWithin(slot.durationMin, DURATION_RANGE) ||
    !minutesWithin(slot.cleanupMin, CLEANUP_RANGE) ||
    slot.staffId === ""
  ) {
    throw new RangeError("appointment slot must be validated before judging warnings");
  }
  const occupied = occupancyOf(slot);
  const warnings: BookingWarning[] = [];

  const appointments = existing.filter(
    (e) =>
      e.id !== options.excludeId &&
      OCCUPYING.has(e.status) &&
      staffContends(e.staffId, slot.staffId) &&
      overlaps(e.occupied, occupied),
  );
  if (appointments.length > 0) warnings.push({ code: "OVERLAP_APPOINTMENT", relatedIds: appointments.map((e) => e.id) });

  const blocking = blocks.filter((b) => blockApplies(b, slot.staffId) && overlaps(b, occupied));
  if (blocking.length > 0) warnings.push({ code: "OVERLAP_BLOCK", relatedIds: blocking.map((b) => b.id) });

  if (!options.skipHoursCheck) {
    const hoursIssue = checkHours(sessionOf(slot), hours);
    if (hoursIssue) warnings.push({ code: hoursIssue, relatedIds: [] });
  }
  return warnings;
}
