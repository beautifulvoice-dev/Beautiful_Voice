// 동명이인 판정 (P2-02, 분해표 C-02). 외부 의존성 없는 순수 함수.
// 규칙 출처: PD-50, BEA-12 수용 기준 "동명이인 구분, 이름만으로 자동 합치지 않음".
// - 같은 이름의 기존 고객이 있으면 "확인 필요"로 표시하고 후보를 돌려준다. 저장을 막지 않는다.
// - 이 함수는 병합을 결정하지 않는다. 전화번호 비교는 원장이 구분하도록 돕는 근거일 뿐이다(같아도 자동 병합 없음).
// 호출 측은 existing에 같은 매장(shop_id)의 고객만 넘겨야 한다(절대 규칙 5).
// 호출 측은 고객 생성 때와, 수정으로 이름이 바뀔 때마다 이 함수를 다시 호출해야 한다(C-07 연결 시 확인).

import { nameKey } from "./customer.ts";

export interface ExistingCustomer {
  id: string;
  name: string;
  /** 정규화된 전화번호(숫자만) 또는 없음. */
  phone: string | null;
}

export interface Subject {
  /** 수정 중인 고객이면 자기 자신을 후보에서 빼기 위해 넘긴다. 새 고객이면 생략. */
  id?: string;
  name: string;
  phone: string | null;
}

/**
 * 원장에게 보여 줄 근거.
 * - same_phone: 전화번호까지 같다 — 같은 사람일 가능성이 높다(중복 등록 의심).
 * - different_phone: 둘 다 번호가 있고 다르다 — 다른 사람일 가능성이 높다.
 * - phone_missing: 한쪽이라도 번호가 없어 판단할 근거가 없다.
 */
export type MatchHint = "same_phone" | "different_phone" | "phone_missing";

export interface Candidate {
  customerId: string;
  name: string;
  phone: string | null;
  hint: MatchHint;
}

export interface SameNameCheck {
  /** 같은 이름 고객이 하나라도 있으면 true. 원장이 확인할 때까지 "확인 필요"로 표시한다. */
  needsReview: boolean;
  /** same_phone → phone_missing → different_phone 순, 같은 근거끼리는 입력 순서 유지. */
  candidates: Candidate[];
}

const HINT_ORDER: Record<MatchHint, number> = { same_phone: 0, phone_missing: 1, different_phone: 2 };

/** 같은 이름(nameKey 기준)의 기존 고객을 찾아 근거와 함께 돌려준다. */
export function checkSameName(subject: Subject, existing: readonly ExistingCustomer[]): SameNameCheck {
  const key = nameKey(subject.name);
  const candidates = existing
    .filter((c) => c.id !== subject.id && nameKey(c.name) === key)
    .map((c): Candidate => ({ customerId: c.id, name: c.name, phone: c.phone, hint: hint(subject.phone, c.phone) }))
    .sort((a, b) => HINT_ORDER[a.hint] - HINT_ORDER[b.hint]);
  return { needsReview: candidates.length > 0, candidates };
}

function hint(a: string | null, b: string | null): MatchHint {
  if (a === null || b === null) return "phone_missing";
  return a === b ? "same_phone" : "different_phone";
}
