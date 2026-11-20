// 고객 비활성화·재활성화 — BEA-173 (명세 1 §2.3, 명세 2 §4.4 customer.active, AC-CRM-4). 외부 의존성 없는 순수 함수.
// - 고객 '삭제'는 비활성화다. 예약·지갑 기록과 잔액은 그대로 조회되고, 예약은 자동 취소하지 않는다 [결정 R30].
//   (이 함수는 고객 행의 값만 정한다. 예약·지갑을 건드리지 않는 것은 쓰기 함수가 지킨다.)
// - 비활성 고객을 다시 살릴 수 있다 [결정 S4].
// - 저장 값 짝: active = (deactivatedAt == null) — 명세 2의 customer_active_deactivated_check와 같다.

export interface ActiveState {
  active: boolean;
  deactivatedAt: Date | null;
}

export type ActiveChange = { ok: true; value: ActiveState } | { ok: false; error: "NO_CHANGE" };

/** 고객을 활성(true)·비활성(false)으로 바꾼 값을 돌려준다. */
export function changeActive(current: ActiveState, active: boolean, now: Date): ActiveChange {
  if (current.active === active) return { ok: false, error: "NO_CHANGE" };
  return { ok: true, value: active ? { active: true, deactivatedAt: null } : { active: false, deactivatedAt: now } };
}
