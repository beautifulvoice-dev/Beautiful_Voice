// 고객 화면(C-03)이 쓰는 데이터 모양과 표시 규칙.
// ASSUMPTION: 11/19 PM 데이터 스키마가 오기 전이라 고객 필드는 C-02(@bv/customers)와 같은 이름·전화·메모만 쓴다.
// 명세 CUS-1의 생년월일·거주지는 스키마 확정 후 추가한다. 메모는 화면에서 "특이사항"(CUS-3)으로 보여 준다.
import type { CustomerValues } from '@bv/customers';

export interface Customer extends CustomerValues {
  id: string;
}

/** 지갑 라벨 6개(WAL-2). 더 늘리지 않는다. */
export type WalletLabel = 'payment' | 'payment_cancel' | 'deduct' | 'deduct_cancel' | 'refund' | 'other';

export const WALLET_LABEL_TEXT: Record<WalletLabel, string> = {
  payment: '결제',
  payment_cancel: '결제 취소',
  deduct: '차감',
  deduct_cancel: '차감 취소',
  refund: '환불',
  other: '기타',
};

export interface WalletEntry {
  id: string;
  /** 기록한 날(ISO). */
  at: string;
  label: WalletLabel;
  /** 부호가 붙은 금액(원). 결제·차감 취소는 +, 결제 취소·차감·환불은 −, 기타는 ±(WAL-2). */
  amount: number;
  memo: string | null;
  createdBy: 'owner' | 'agent';
}

/** 잔액 = 모든 기록의 합(WAL-3). */
export function walletBalance(entries: readonly WalletEntry[]): number {
  return entries.reduce((sum, e) => sum + e.amount, 0);
}

/** 방문 기록에는 확정된 세션만 온다(VIS-1). 요청 상태는 여기 없다. */
export type VisitStatus = 'confirmed' | 'completed' | 'cancelled' | 'no_show';

export interface Visit {
  id: string;
  startsAt: string;
  menu: string;
  status: VisitStatus;
}

/** VIS-2: 앞으로의 확정은 "방문 예정", 지난 확정은 자동 완료(R-8). */
export function visitStatusText(visit: Visit, now: Date): string {
  if (visit.status === 'cancelled') return '취소';
  if (visit.status === 'no_show') return '노쇼';
  if (visit.status === 'completed' || new Date(visit.startsAt) <= now) return '완료';
  return '방문 예정';
}

export interface CustomerDetail extends Customer {
  wallet: WalletEntry[];
  visits: Visit[];
}

const won = new Intl.NumberFormat('ko-KR');
export function formatWon(amount: number, signed = false): string {
  const sign = signed && amount > 0 ? '+' : amount < 0 ? '−' : '';
  return `${sign}${won.format(Math.abs(amount))}원`;
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
const seoulDate = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: 'numeric', day: 'numeric' });
export const formatDateTime = (iso: string) => seoulDateTime.format(new Date(iso));
export const formatDate = (iso: string) => seoulDate.format(new Date(iso));

/** 숫자만 저장된 번호를 읽기 쉽게: 01000000001 → 010-0000-0001, 0200000000 → 02-0000-0000. */
export function formatPhone(digits: string): string {
  if (digits.startsWith('02')) return digits.replace(/^(02)(\d{3,4})(\d{4})$/, '$1-$2-$3');
  return digits.replace(/^(\d{3})(\d{3,4})(\d{4})$/, '$1-$2-$3');
}
