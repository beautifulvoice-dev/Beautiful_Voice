// S4 지갑 계약 타입 — wallet.openapi.yaml과 같은 모양. 매장은 로그인 세션으로 정한다(ADR-0009 A단계).
// 응답 타입은 모든 칸이 온다(값이 없으면 null). 잔액·잔여 횟수는 음수일 수 있다.

export type WalletUnitType = 'amount' | 'sessions';

export type WalletEntryLabel = 'payment' | 'deduct' | 'opening_balance' | 'refund' | 'deduct_cancel' | 'payment_cancel';

export interface PassSummary {
  id: string;
  name: string;
  menuId: string | null;
  /** 발급 당시 메뉴 이름 */
  menuName: string | null;
  remainingSessions: number;
  isPrimary: boolean;
  version: number;
}

/** GET /api/wallets/{customerId} */
export interface WalletSummary {
  customerId: string;
  prepaidBalance: number;
  /** 보이는 횟수권만. 대표 먼저, 그다음 발급순 */
  passes: PassSummary[];
}

/** POST /api/passes 응답 */
export interface CustomerPass extends PassSummary {
  customerId: string;
}

/** POST /api/passes 본문. 구매 금액(원)은 지갑 거래가 아니다 */
export interface PassInput {
  customerId: string;
  name: string;
  menuId: string;
  sessions: number;
  isPrimary?: boolean;
}

/** POST /api/wallet-entries 본문. value는 양수, 부호는 서버가 label로 정한다 */
export interface WalletEntryInput {
  customerId: string;
  unitType: WalletUnitType;
  /** sessions면 필수 */
  passId?: string | null;
  label: 'payment' | 'deduct';
  value: number;
  memo?: string | null;
}

/** GET /api/wallet-entries 항목 */
export interface WalletEntry {
  id: string;
  customerId: string;
  unitType: WalletUnitType;
  passId: string | null;
  label: WalletEntryLabel;
  signedDelta: number;
  /** 종료 5분 전 완료 카드 차감이면 그 예약 */
  appointmentId: string | null;
  cycleSeq: number | null;
  memo: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** POST /api/wallet-entries 응답 — 적용 직후 값. 해당 단위가 아니면 null */
export interface WalletEntryRecorded extends WalletEntry {
  prepaidBalance: number | null;
  remainingSessions: number | null;
}
