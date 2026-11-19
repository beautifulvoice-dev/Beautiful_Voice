// 개발용 합성 데이터. 실제 고객이 아니다(절대 규칙 8) — 전화번호는 모두 010-0000-xxxx.
// ASSUMPTION: PM 가짜 데이터([P2] 4. 데이터 §5, 11/19 전달 예정)가 오면 같은 형식으로 바꾼다.
import type { MemorySeed } from './api';
import type { WalletEntry } from './model';

const DAY = 86_400_000;
const at = (days: number, hour: number) => {
  const d = new Date(Date.now() + days * DAY);
  d.setUTCHours(hour - 9, 0, 0, 0); // 서울 시각 hour시
  return d.toISOString();
};

let n = 0;
const entry = (days: number, label: WalletEntry['label'], amount: number, memo: string | null = null): WalletEntry => ({
  id: `w${++n}`,
  at: at(days, 12),
  label,
  amount,
  memo,
  createdBy: 'owner',
});

export function seedCustomers(): MemorySeed {
  return {
    customers: [
      { id: 'c1', name: '김하늘', phone: '01000000001', memo: '민감성 피부' },
      { id: 'c2', name: '김하늘', phone: '01000000002', memo: null },
      { id: 'c3', name: '이서윤', phone: '01000000003', memo: '임산부 — 복부 관리 제외' },
      { id: 'c4', name: '박지민', phone: null, memo: null },
    ],
    wallet: {
      c1: [
        entry(-30, 'payment', 300_000, '10회권'),
        entry(-21, 'deduct', -30_000),
        entry(-7, 'deduct', -30_000),
      ],
      c3: [entry(-3, 'payment', 50_000, '당일 결제'), entry(-3, 'deduct', -50_000)],
    },
    visits: {
      c1: [
        { id: 'v1', startsAt: at(-21, 11), menu: '수분 관리', status: 'completed' },
        { id: 'v2', startsAt: at(-14, 11), menu: '수분 관리', status: 'no_show' },
        { id: 'v3', startsAt: at(-7, 11), menu: '수분 관리', status: 'confirmed' },
        { id: 'v4', startsAt: at(3, 15), menu: '수분 관리', status: 'confirmed' },
      ],
      c3: [{ id: 'v5', startsAt: at(-3, 14), menu: '등 관리', status: 'completed' }],
    },
  };
}
