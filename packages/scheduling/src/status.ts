// ⚠️ 11/18 규칙(매장 최대 2건·자리·그대로 저장·세션 뒤 준비 시간 / 요청·확정·자동 완료) — 11/19 명세 최종판으로 대체됐다.
//    새 규칙은 booking.ts(BEA-177)·appointment-status.ts(BEA-178). apps/server의 AppointmentService(#33)가 이 파일을 쓰므로
//    2F 스키마(BEA-155) 위에서 예약 쓰기 함수(BEA-176)를 다시 만들 때 함께 지운다.
// 예약 상태 전이 (P2-03, 분해표 C-04). 외부 의존성 없는 순수 함수.
// 규칙 출처: Linear「[P2] 2. 상세 기능 명세서」R-6~R-10(11/18, 옛 PD-17~19).
// - 상태 5개: 요청·확정·취소·노쇼·완료(R-6).
// - 원장이 만든 예약(웹 입력, 마이크·채팅 변경안 승인)은 승인 = 확정. 요청은 원장이 아닌 경로(Phase 3 전화 등)만(R-7).
// - 원장이 취소·노쇼 처리하지 않은 확정 예약은 끝 시각이 지나면 완료. 완료는 나중에 노쇼로 바꿀 수 있다.
//   요청 상태는 시간이 지나도 요청으로 남는다(R-8·R-9).
// 마이크·채팅·웹 모두 같은 전이를 쓴다. 어디서 왔는지는 이력의 source로만 구분한다.
// AI는 전이를 직접 일으키지 않는다 — 변경안을 원장이 승인하면 actor는 owner, source는 voice/chat이다(절대 규칙 3).

export type AppointmentStatus = "requested" | "confirmed" | "canceled" | "no_show" | "completed";

/** 자리를 차지하는 상태. sql/appointment_conflict.sql의 배타 제약 WHERE와 같아야 한다. */
export const OCCUPIES_LANE: ReadonlySet<AppointmentStatus> = new Set(["confirmed", "completed"]);

/** 누가 일으켰나. owner = 원장(직접 또는 변경안 승인), system = 자동 처리, external = 원장이 아닌 접수 경로. */
export type Actor = "owner" | "system" | "external";

/** 어디서 왔나. voice = 마이크 변경안 승인, chat = 채팅 변경안 승인. */
export type Source = "web" | "voice" | "chat" | "phone" | "import" | "system";

export type StatusAction =
  | "approve" // 요청 → 확정
  | "reject" // 요청 → 취소
  | "cancel" // 요청·확정 → 취소
  | "mark_no_show" // 확정·완료 → 노쇼
  | "undo_no_show" // 노쇼 → 확정·완료 (원장 실수 정정)
  | "complete"; // 확정 → 완료 (시스템, 끝 시각 이후)

export interface AppointmentState {
  status: AppointmentStatus;
  start: Date;
  end: Date;
}

export interface TransitionContext {
  actor: Actor;
  source: Source;
  now: Date;
  reason?: string;
}

/** appointment_event로 저장할 이력 한 건. */
export interface StatusEvent {
  type: "created" | StatusAction;
  from: AppointmentStatus | null;
  to: AppointmentStatus;
  actor: Actor;
  source: Source;
  at: Date;
  reason?: string;
}

export type TransitionError =
  | "INVALID_TRANSITION" // 이 상태에서 할 수 없는 동작
  | "ACTOR_NOT_ALLOWED" // 이 주체가 할 수 없는 동작
  | "TOO_EARLY"; // 아직 할 수 없는 시각(노쇼는 시작 이후, 완료는 끝 이후)

export type TransitionResult =
  | {
      ok: true;
      to: AppointmentStatus;
      /** 자리를 비어 있던 상태에서 다시 차지하게 되면 true — 저장 전에 C-05 decideSave로 충돌을 검사해야 한다. */
      needsConflictCheck: boolean;
      event: StatusEvent;
    }
  | { ok: false; error: TransitionError };

/**
 * 화면·조회에서 쓰는 상태. 확정 예약의 끝 시각이 지났으면 완료로 본다(R-8).
 * 2A에는 워커가 없으므로 저장값을 바꾸는 대신 조회 시점에 계산한다. 자리 점유는 확정·완료가 같아 충돌 판정에 영향이 없다.
 */
export function effectiveStatus(a: AppointmentState, now: Date): AppointmentStatus {
  if (a.status === "confirmed" && a.end.getTime() <= now.getTime()) return "completed";
  return a.status;
}

/** 새 예약의 첫 상태와 생성 이력. 원장이 만들면 확정(충돌 검사 필요), 원장이 아닌 경로면 요청. */
export function initialStatus(ctx: TransitionContext): TransitionResult {
  if (ctx.actor === "system") return { ok: false, error: "ACTOR_NOT_ALLOWED" };
  const to: AppointmentStatus = ctx.actor === "owner" ? "confirmed" : "requested";
  return { ok: true, to, needsConflictCheck: OCCUPIES_LANE.has(to), event: event("created", null, to, ctx) };
}

interface Rule {
  from: readonly AppointmentStatus[];
  actors: readonly Actor[];
  to: (a: AppointmentState, now: Date) => AppointmentStatus;
  /** 시각 조건. 만족하지 않으면 TOO_EARLY. */
  when?: (a: AppointmentState, now: Date) => boolean;
}

const pastEnd = (a: AppointmentState, now: Date) => a.end.getTime() <= now.getTime();
const afterStart = (a: AppointmentState, now: Date) => a.start.getTime() <= now.getTime();

// from은 effectiveStatus 기준이다(끝난 확정 예약은 completed로 본다).
const RULES: Record<StatusAction, Rule> = {
  approve: { from: ["requested"], actors: ["owner"], to: () => "confirmed" },
  reject: { from: ["requested"], actors: ["owner"], to: () => "canceled" },
  // ASSUMPTION: 완료된 예약은 취소할 수 없다(이미 끝남 — 노쇼 정정만 허용). 취소는 되살리지 않는다(새 예약으로).
  cancel: { from: ["requested", "confirmed"], actors: ["owner"], to: () => "canceled" },
  // ASSUMPTION: 노쇼는 예약 시작 시각 이후에만 표시할 수 있다.
  mark_no_show: { from: ["confirmed", "completed"], actors: ["owner"], to: () => "no_show", when: afterStart },
  // ASSUMPTION: 노쇼를 잘못 눌렀으면 되돌릴 수 있다. 끝 시각 전이면 확정, 후면 완료로 돌아간다.
  undo_no_show: {
    from: ["no_show"],
    actors: ["owner"],
    to: (a, now) => (pastEnd(a, now) ? "completed" : "confirmed"),
  },
  complete: { from: ["confirmed"], actors: ["system"], to: () => "completed", when: pastEnd },
};

/** 상태를 바꿀 수 있는지 판정하고, 바뀔 상태와 이력 이벤트를 만든다. 저장은 호출 측(C-07)이 한 트랜잭션에서 한다. */
export function transition(a: AppointmentState, action: StatusAction, ctx: TransitionContext): TransitionResult {
  const rule = RULES[action];
  // complete는 저장값이 confirmed인 예약을 실제로 completed로 바꾸는 시스템 동작이라 저장값 기준으로 본다.
  const current = action === "complete" ? a.status : effectiveStatus(a, ctx.now);
  if (!rule.from.includes(current)) return { ok: false, error: "INVALID_TRANSITION" };
  if (!rule.actors.includes(ctx.actor)) return { ok: false, error: "ACTOR_NOT_ALLOWED" };
  if (rule.when && !rule.when(a, ctx.now)) return { ok: false, error: "TOO_EARLY" };

  const to = rule.to(a, ctx.now);
  return {
    ok: true,
    to,
    needsConflictCheck: !OCCUPIES_LANE.has(current) && OCCUPIES_LANE.has(to),
    event: event(action, current, to, ctx),
  };
}

function event(
  type: StatusEvent["type"],
  from: AppointmentStatus | null,
  to: AppointmentStatus,
  ctx: TransitionContext,
): StatusEvent {
  const e: StatusEvent = { type, from, to, actor: ctx.actor, source: ctx.source, at: ctx.now };
  if (ctx.reason !== undefined) e.reason = ctx.reason;
  return e;
}
