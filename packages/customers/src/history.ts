// 고객 수정 이력 이벤트 (P2-02, 분해표 C-02). 외부 의존성 없는 순수 함수.
// 예약 상태 이력(C-04 StatusEvent)과 같은 형태: 무엇이·누가·어디서·언제.
// AI는 고객 데이터를 직접 바꾸지 않는다(절대 규칙 3). 마이크·채팅 변경안을 원장이 승인하면 actor는 owner, source는 voice/chat이다.
// 이벤트에는 변경 전후 값(개인정보)이 들어간다 — DB 이력 테이블에만 저장하고 로그로 출력하지 않는다(절대 규칙 8).

import type { CustomerField, CustomerValues } from "./customer.ts";

/**
 * 누가 일으켰나. 예약 이력(C-04 status.ts)과 같은 값 집합 — C-07에서 고객·예약 이력을 같은 형태로 저장한다.
 * owner = 원장(직접 또는 변경안 승인), system = 일괄 가져오기 등 자동 처리, external = 원장이 아닌 접수 경로(Phase 3 전화 등).
 */
export type Actor = "owner" | "system" | "external";

/** 어디서 왔나. C-04와 같은 값 집합. voice = 마이크 변경안 승인, chat = 채팅 변경안 승인, import = 일괄 가져오기. */
export type Source = "web" | "voice" | "chat" | "phone" | "import" | "system";

/**
 * ASSUMPTION: external은 고객을 만들거나 고칠 수 없다(ACTOR_NOT_ALLOWED). 원장이 아닌 경로(AI 전화 접수 포함)가
 * 고객 데이터를 바꾸면 원장 승인 없는 변경이 된다(절대 규칙 3). Phase 3에서 전화 접수 고객 처리가 정해지면 다시 본다.
 */
const ALLOWED_ACTORS: ReadonlySet<Actor> = new Set(["owner", "system"]);

export type HistoryError = { ok: false; error: "ACTOR_NOT_ALLOWED" };

export interface HistoryContext {
  actor: Actor;
  source: Source;
  now: Date;
  reason?: string;
}

export interface FieldChange {
  field: CustomerField;
  from: string | null;
  to: string | null;
}

/** customer_event로 저장할 이력 한 건. */
export interface CustomerEvent {
  type: "created" | "updated";
  /** 생성은 값이 있는 필드 전부(from = null), 수정은 실제로 바뀐 필드만. */
  changes: FieldChange[];
  actor: Actor;
  source: Source;
  at: Date;
  reason?: string;
}

const FIELDS: readonly CustomerField[] = ["name", "phone", "memo"];

/** 생성 이력. values는 validateNewCustomer를 통과한 값이어야 한다. */
export function customerCreated(values: CustomerValues, ctx: HistoryContext): { ok: true; event: CustomerEvent } | HistoryError {
  if (!ALLOWED_ACTORS.has(ctx.actor)) return { ok: false, error: "ACTOR_NOT_ALLOWED" };
  const changes = FIELDS.filter((f) => values[f] !== null).map((f) => ({ field: f, from: null, to: values[f] }));
  return { ok: true, event: event("created", changes, ctx) };
}

/**
 * 수정 이력. 바뀐 필드가 없으면 event = null — 이력을 남기지 않고 저장도 생략할 수 있다.
 * before·after 모두 정규화된 값이어야 한다(after = applyPatch(before, validateCustomerPatch 결과)). 정규화 전 값을 넘기면 공백만 다른 값도 변경으로 남는다.
 */
export function customerUpdated(
  before: CustomerValues,
  after: CustomerValues,
  ctx: HistoryContext,
): { ok: true; event: CustomerEvent | null } | HistoryError {
  if (!ALLOWED_ACTORS.has(ctx.actor)) return { ok: false, error: "ACTOR_NOT_ALLOWED" };
  const changes = FIELDS.filter((f) => before[f] !== after[f]).map((f) => ({ field: f, from: before[f], to: after[f] }));
  return { ok: true, event: changes.length === 0 ? null : event("updated", changes, ctx) };
}

function event(type: CustomerEvent["type"], changes: FieldChange[], ctx: HistoryContext): CustomerEvent {
  const e: CustomerEvent = { type, changes, actor: ctx.actor, source: ctx.source, at: ctx.now };
  if (ctx.reason !== undefined) e.reason = ctx.reason;
  return e;
}
