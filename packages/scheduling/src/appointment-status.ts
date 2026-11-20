// 예약 상태와 정정 — BEA-178 (명세 3 기능 2A-3.3, 명세 1 §2.2 상태 전이표, 명세 2 §4.4). 외부 의존성 없는 순수 함수.
// 2026-11-19 명세 최종판 기준. 11/18 규칙(요청·확정·자동 완료)을 담은 status.ts를 대체한다.
// - 상태는 예정·완료·취소·노쇼·무효 5종. 생성은 예정만.
// - 예정·완료·취소·노쇼 네 가지 사이는 원장(과 승인된 AI 업무)이 어느 방향으로든 바꿀 수 있다 — 잘못 표시한 상태 정정 [결정 S5].
// - 무효는 AI가 만든 예약의 되돌리기(예정 → 무효)에서만 생기고, 무효에서 나가는 전이는 없다.
// - 취소를 되살리면 점유가 다시 생기므로 겹침 검사가 필요하다(최종 보장은 DB 배타 제약).
// - 완료해도 지갑을 자동 차감하지 않는다(이 함수는 상태만 다룬다).
// ASSUMPTION: 명세에 시각 조건(예: 시작 전 완료·노쇼 금지)이 없어 두지 않는다.

export const APPOINTMENT_STATUSES = ["scheduled", "completed", "cancelled", "no_show", "voided"] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

/** 점유하는 상태. DB 배타 제약의 WHERE(취소·무효 제외)와 같아야 한다. */
export const OCCUPYING: ReadonlySet<AppointmentStatus> = new Set(["scheduled", "completed", "no_show"]);

export type StatusChange =
  | { ok: true; to: AppointmentStatus; needsOverlapCheck: boolean }
  | { ok: false; error: "INVALID_TRANSITION" | "NO_CHANGE" };

/**
 * 상태를 바꿀 수 있는지 판정한다.
 * @param context.undoOfTask 업무 되돌리기 경로인지(`appointment_create` 되돌림만 무효로 보낼 수 있다)
 */
export function changeStatus(
  from: AppointmentStatus,
  to: AppointmentStatus,
  context: { undoOfTask: boolean },
): StatusChange {
  if (from === to) return { ok: false, error: "NO_CHANGE" };
  if (from === "voided") return { ok: false, error: "INVALID_TRANSITION" };
  if (to === "voided") {
    return from === "scheduled" && context.undoOfTask
      ? { ok: true, to, needsOverlapCheck: false }
      : { ok: false, error: "INVALID_TRANSITION" };
  }
  return { ok: true, to, needsOverlapCheck: !OCCUPYING.has(from) && OCCUPYING.has(to) };
}
