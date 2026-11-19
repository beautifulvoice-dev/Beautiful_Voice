// 고객 화면(C-03)이 쓰는 데이터 모양과 표시 규칙.
// 고객 필드는 지금 C-02(@bv/customers)와 같은 이름·전화·메모만 쓴다. 메모는 화면에서 "특이사항"으로 보여 준다.
// 생년월일·거주지(명세 1 §2.3)는 명세 2 데이터 스키마의 형식을 확인한 뒤 추가한다.
import type { CustomerValues } from '@bv/customers';

export interface Customer extends CustomerValues {
  id: string;
}

/**
 * 예약 상태 5종(명세 1 §2.2). 방문 기록은 예약 상태로 표현한다.
 * 완료·노쇼는 원장이 직접 표시한다 — 시간이 지났다고 자동으로 완료되지 않는다.
 */
export type VisitStatus = 'scheduled' | 'completed' | 'cancelled' | 'no_show' | 'voided';

export interface Visit {
  id: string;
  startsAt: string;
  menu: string;
  status: VisitStatus;
}

export const VISIT_STATUS_TEXT: Record<Exclude<VisitStatus, 'voided'>, string> = {
  scheduled: '예정',
  completed: '완료',
  cancelled: '취소',
  no_show: '노쇼',
};

/**
 * 고객 상세에 보일 예약·방문 이력. 최근 것부터.
 * ASSUMPTION: 무효(voided)는 AI 예약을 되돌린 것이라 실제 방문이 아니므로 이력에서 뺀다.
 */
export function visitHistory(visits: readonly Visit[]): (Visit & { status: Exclude<VisitStatus, 'voided'> })[] {
  return visits
    .filter((v): v is Visit & { status: Exclude<VisitStatus, 'voided'> } => v.status !== 'voided')
    .sort((a, b) => b.startsAt.localeCompare(a.startsAt));
}

export interface CustomerDetail extends Customer {
  visits: Visit[];
}

// 표시는 매장 시간대 기준(절대 규칙 7). 2A는 서울 고정(#19 결정).
const seoulDateTime = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul',
  month: 'numeric',
  day: 'numeric',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
export const formatDateTime = (iso: string) => seoulDateTime.format(new Date(iso));

/** 숫자만 저장된 번호를 읽기 쉽게: 01000000001 → 010-0000-0001, 0200000000 → 02-0000-0000. */
export function formatPhone(digits: string): string {
  if (digits.startsWith('02')) return digits.replace(/^(02)(\d{3,4})(\d{4})$/, '$1-$2-$3');
  return digits.replace(/^(\d{3})(\d{3,4})(\d{4})$/, '$1-$2-$3');
}
