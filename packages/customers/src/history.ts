// 고객 수정 이력 이벤트 (P2-02, 분해표 C-02). 외부 의존성 없는 순수 함수.
// 예약 상태 이력(C-04 StatusEvent)과 같은 형태: 무엇이·누가·어디서·언제.
// AI는 고객 데이터를 직접 바꾸지 않는다(절대 규칙 3). 마이크·채팅 변경안을 원장이 승인하면 actor는 owner, source는 voice/chat이다.
// 이벤트에는 변경 전후 값(개인정보)이 들어간다 — DB 이력 테이블에만 저장하고 로그로 출력하지 않는다(절대 규칙 8).

import type { CustomerField, CustomerValues } from "./customer.ts";

/**
 * 누가 일으켰나. owner = 원장(직접 또는 변경안 승인), system = 일괄 가져오기 등 자동 처리.
 * ASSUMPTION: 고객은 원장 또는 시스템(가져오기)만 만들고 고친다. 전화 접수(Phase 3) 경로는 그때 추가한다.
 */
export type Actor = "owner" | "system";

/** 어디서 왔나. voice = 마이크 변경안 승인, chat = 채팅 변경안 승인, import = 일괄 가져오기. */
export type Source = "web" | "voice" | "chat" | "import";

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
export function customerCreated(values: CustomerValues, ctx: HistoryContext): CustomerEvent {
  const changes = FIELDS.filter((f) => values[f] !== null).map((f) => ({ field: f, from: null, to: values[f] }));
  return event("created", changes, ctx);
}

/** 수정 이력. 바뀐 필드가 없으면 null — 이력을 남기지 않고 저장도 생략할 수 있다. */
export function customerUpdated(before: CustomerValues, after: CustomerValues, ctx: HistoryContext): CustomerEvent | null {
  const changes = FIELDS.filter((f) => before[f] !== after[f]).map((f) => ({ field: f, from: before[f], to: after[f] }));
  return changes.length === 0 ? null : event("updated", changes, ctx);
}

function event(type: CustomerEvent["type"], changes: FieldChange[], ctx: HistoryContext): CustomerEvent {
  const e: CustomerEvent = { type, changes, actor: ctx.actor, source: ctx.source, at: ctx.now };
  if (ctx.reason !== undefined) e.reason = ctx.reason;
  return e;
}
