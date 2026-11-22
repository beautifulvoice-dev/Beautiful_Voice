// 예약 넣기(W3)의 문구: 점유 미리보기와 저장 거부 이유(화면 설계서 W3 거부 표, 디자인 캡처 w2.png).
import type { BookingReject } from '@bv/scheduling/booking';
import { dayStart, shopDate, shopTime, type CalendarData } from './model';

const MIN = 60_000;
const DAY_NAME = ['일', '월', '화', '수', '목', '금', '토'];

/** "11/24(화)" (C-1 날짜 표기). */
export function shortDate(date: string): string {
  return `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}(${DAY_NAME[new Date(`${date}T00:00:00Z`).getUTCDay()]})`;
}

/** 점유 미리보기 "13:50부터 15:30까지 이실장 일정이 잡혀요"(결정 R33). */
export function occupancyText(startAt: string, durationMin: number, prepMin: number, staffName: string): string {
  const start = Date.parse(startAt);
  return `${shopTime(start - prepMin * MIN)}부터 ${shopTime(start + durationMin * MIN)}까지 ${staffName} 일정이 잡혀요`;
}

export interface RejectContext {
  data: Pick<CalendarData, 'appointments' | 'blocks' | 'businessHours' | 'staff'>;
  staffId: string;
  startAt: string;
}

/** 저장 거부 이유 → 저장 버튼 위 빨간 알림 본문. 제목은 "저장하지 못했어요". */
export function rejectText(reason: BookingReject | 'INVALID_TRANSITION', conflictingIds: readonly string[], ctx: RejectContext): string {
  const staffName = ctx.data.staff.find((s) => s.id === ctx.staffId)?.name ?? '담당자';
  const range = (from: string | number, to: string | number) => `${shopTime(from)}–${shopTime(to)}`;
  switch (reason) {
    case 'STAFF_OVERLAP': {
      const a = ctx.data.appointments.find((x) => x.id === conflictingIds[0]);
      if (!a) return `${staffName}은 그 시간에 다른 예약이 있어요. 시간을 바꾸거나 다른 담당자를 골라 주세요.`;
      const start = Date.parse(a.startAt);
      return `${staffName}은 ${range(start, start + a.durationMin * MIN)}에 ${a.customerName} 님 예약이 있어요. 시간을 바꾸거나 다른 담당자를 골라 주세요.`;
    }
    case 'BLOCKED': {
      const b = ctx.data.blocks.find((x) => x.id === conflictingIds[0]);
      const what = b ? `${range(b.startAt, b.endAt)}은 ` : '';
      const memo = b?.memo ? `(${b.memo})` : '';
      // 디자인 캡처: 담당자 지정 차단은 "이실장의 관리 불가 시간", 매장 전체 차단은 담당자를 바꿔도 소용없으니 시간만 권한다.
      return b && !b.allStaff
        ? `${what}${staffName}의 관리 불가 시간${memo}이에요. 시간을 바꾸거나 다른 담당자를 골라 주세요.`
        : `${what}관리 불가 시간${memo}이에요. 시간을 바꿔 주세요.`;
    }
    case 'OUTSIDE_BUSINESS_HOURS': {
      const day = shopDate(Date.parse(ctx.startAt));
      const key = String(((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7) + 1) as keyof NonNullable<CalendarData['businessHours']>;
      const windows = ctx.data.businessHours?.[key] ?? [];
      const hours = windows.map((w) => `${w.open}–${w.close}`).join(', ');
      return `영업시간${hours ? `(${hours})` : ''} 밖이에요. 관리가 영업시간 안에 끝나야 해요.`;
    }
    case 'CLOSED_DAY':
      return `${shortDate(shopDate(Date.parse(ctx.startAt)))}은 휴무일이에요.`;
    case 'STAFF_REQUIRED':
      return '담당자를 골라 주세요.';
    case 'INVALID_PERIOD':
      return '관리 시간을 확인해 주세요.';
    case 'INVALID_TRANSITION':
      return '이 상태로는 바꿀 수 없어요.';
  }
}

/** 매장 날짜 + "HH:MM" → UTC ISO(W3·W4 입력). */
export function shopIso(date: string, hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return new Date(dayStart(date) + (h * 60 + m) * MIN).toISOString();
}
