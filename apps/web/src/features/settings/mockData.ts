// 개발용 합성 설정 데이터. 실제 매장이 아니다(절대 규칙 8).
// ASSUMPTION: 1인 매장 — 담당자는 원장 1명(PM 메모: 담당자는 기본 원장). PM 가짜 데이터가 오면 같은 모양으로 바꾼다.
import type { SettingsSeed } from './api';

const AT = '2026-11-01T00:00:00.000Z';
const row = { version: 1, createdAt: AT, updatedAt: AT };

export function seedSettings(): SettingsSeed {
  return {
    // 화~토 10:00~20:00, 일 11:00~18:00, 월요일 쉼(키 없음).
    businessHours: {
      '2': [{ open: '10:00', close: '20:00' }],
      '3': [{ open: '10:00', close: '20:00' }],
      '4': [{ open: '10:00', close: '20:00' }],
      '5': [{ open: '10:00', close: '20:00' }],
      '6': [{ open: '10:00', close: '20:00' }],
      '7': [{ open: '11:00', close: '18:00' }],
    },
    // 합성 매장 링크(실제 매장 아님).
    shopInfo: {
      locationText: '합성시 가상구 예시로 12, 2층',
      naverPlaceUrl: 'https://naver.me/example',
      instagramUrl: 'https://instagram.com/example.beauty',
      landingUrl: null,
      refundPolicy: '예약 하루 전까지 취소하면 전액 돌려드려요.',
    },
    closures: [
      { id: 'closure-1', kind: 'weekly', weekday: 1, note: null },
      { id: 'closure-2', kind: 'vacation', startDate: '2026-12-24', endDate: '2026-12-26', note: '연말 휴가' },
    ],
    menus: [
      { id: 'menu-1', name: '수분 관리', defaultDurationMin: 60, defaultPrepMin: 10, defaultCleanupMin: 10, defaultPrice: 0, active: true, ...row },
      { id: 'menu-2', name: '등 관리', defaultDurationMin: 90, defaultPrepMin: 10, defaultCleanupMin: 10, defaultPrice: 0, active: true, ...row },
      { id: 'menu-3', name: '여름 진정 관리', defaultDurationMin: 50, defaultPrepMin: null, defaultCleanupMin: null, defaultPrice: 0, active: false, ...row },
    ],
    staff: [{ id: 'staff-1', name: '원장', active: true, ...row }],
  };
}
