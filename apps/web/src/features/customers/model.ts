// 고객 화면(C-03)이 쓰는 데이터 모양과 표시 규칙.
// 고객 필드는 @bv/customers와 같다: 이름(필수)·전화·메모·생년월일·거주지(BEA-172, 명세 1 §2.3). 메모는 화면에서 "특이사항"으로 보여 준다.
import type { CustomerValues } from '@bv/customers';

export interface Customer extends CustomerValues {
  id: string;
  /** 실제 API의 행 버전 — 고칠 때 그대로 보낸다(계약 #42 동시 수정). 가짜 저장소는 비워 둔다. */
  version?: number;
  /** false = 비활성(숨김) 고객. 새 예약에 고를 수 없다(설계 04 D3). */
  active?: boolean;
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
 * 무효(voided)는 방문 이력과 점유에서 빠진다(명세 1 §3.3 되돌리기).
 */
export function visitHistory(visits: readonly Visit[]): (Visit & { status: Exclude<VisitStatus, 'voided'> })[] {
  return visits
    .filter((v): v is Visit & { status: Exclude<VisitStatus, 'voided'> } => v.status !== 'voided')
    .sort((a, b) => b.startsAt.localeCompare(a.startsAt));
}

export interface CustomerDetail extends Customer {
  /** null = 이력을 아직 받아 올 수 없음(실제 API에 고객별 이력 창구가 없다, #42). 빈 배열(이력 없음)과 구분한다. */
  visits: Visit[] | null;
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

/** 생년월일 "1990-02-28" → "1990년 2월 28일". 날짜 문자열을 그대로 읽어 시간대에 흔들리지 않게 한다. */
export function formatBirthdate(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  return `${y}년 ${m}월 ${d}일`;
}

const seoulYmd = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' });
/** 매장 날짜 기준 오늘 "YYYY-MM-DD"(절대 규칙 7, 서울 고정). 생년월일 달력의 끝 날짜로 쓴다. */
export const shopToday = (now: Date = new Date()) => seoulYmd.format(now);
