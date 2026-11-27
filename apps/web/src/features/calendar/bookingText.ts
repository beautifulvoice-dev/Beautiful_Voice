// 예약 넣기(W3)의 문구: 점유 미리보기, 경고 4종(rev.3.1 — 겹쳐도 저장), 저장 거부 이유(화면 설계서 W3 거부 표).
import type { BookingWarning } from '@bv/contracts';
import { occupancyOf } from '@bv/scheduling/warnings';
import type { SaveReject } from './api';
import { dayStart, shopDate, shopTime, type CalendarData } from './model';

const MIN = 60_000;
const DAY_NAME = ['일', '월', '화', '수', '목', '금', '토'];

/** "11/24(화)" (C-1 날짜 표기). */
export function shortDate(date: string): string {
  return `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}(${DAY_NAME[new Date(`${date}T00:00:00Z`).getUTCDay()]})`;
}

/** 점유 미리보기: "14:00부터 15:10까지 박원장 일정이 잡혀요"(시술 + 정리, rev.3.1). */
export function occupancyText(startAt: string, durationMin: number, cleanupMin: number, staffName: string | null): string {
  const occupied = occupancyOf({ start: new Date(startAt), durationMin, cleanupMin });
  const who = staffName ? `${staffName} 일정이` : '일정이(담당자 미지정)';
  return `${shopTime(occupied.start.getTime())}부터 ${shopTime(occupied.end.getTime())}까지 ${who} 잡혀요`;
}

export interface WarningContext {
  data: Pick<CalendarData, 'appointments' | 'blocks' | 'businessHours'>;
  startAt: string;
}

/** 경고 4종 → 예약 폼 안 빨간 안내 한 줄(설계 12 §5-1). 겹친 예약·차단은 받은 캘린더에 있으면 이름·시각까지. */
export function warningText(w: BookingWarning, ctx: WarningContext): string {
  const range = (from: string | number, to: string | number) => `${shopTime(from)}–${shopTime(to)}`;
  switch (w.code) {
    case 'OVERLAP_APPOINTMENT': {
      const names = w.relatedIds
        .map((id) => ctx.data.appointments.find((x) => x.id === id))
        .filter((a) => a !== undefined)
        .map((a) => `${range(a.startAt, Date.parse(a.startAt) + a.durationMin * MIN)} ${a.customerName} 님`);
      return names.length > 0 ? `${names.join(', ')} 예약과 겹쳐요.` : `다른 예약 ${w.relatedIds.length}건과 겹쳐요.`;
    }
    case 'OVERLAP_BLOCK': {
      const b = ctx.data.blocks.find((x) => x.id === w.relatedIds[0]);
      return b ? `관리 불가 시간(${range(b.startAt, b.endAt)}${b.memo ? ` ${b.memo}` : ''})과 겹쳐요.` : '관리 불가 시간과 겹쳐요.';
    }
    case 'OUTSIDE_BUSINESS_HOURS': {
      const day = shopDate(Date.parse(ctx.startAt));
      const key = String(((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7) + 1) as keyof NonNullable<CalendarData['businessHours']>;
      const hours = (ctx.data.businessHours?.[key] ?? []).map((x) => `${x.open}–${x.close}`).join(', ');
      return `영업시간${hours ? `(${hours})` : ''} 밖이에요.`;
    }
    case 'CLOSED_DAY':
      return `${shortDate(shopDate(Date.parse(ctx.startAt)))}은 휴무일이에요.`;
  }
}

/** 같은 경고(코드 + 대상 id). 순서만 다르면 같은 것으로 본다. */
const warningKeys = (ws: readonly BookingWarning[]) => new Set(ws.flatMap((w) => (w.relatedIds.length ? w.relatedIds.map((id) => `${w.code}|${id}`) : [w.code])));

/**
 * 저장 응답에만 있는 경고(설계 12 §5-1): 미리 보기에 없던 코드 + 대상 id. 순서만 다르면 새 경고가 아니고,
 * 같은 코드에 대상이 한 건 늘면 그 한 건만 새 것이다.
 */
export function newWarnings(preview: readonly BookingWarning[], saved: readonly BookingWarning[]): BookingWarning[] {
  const seen = warningKeys(preview);
  const out: BookingWarning[] = [];
  for (const w of saved) {
    if (w.relatedIds.length === 0) {
      if (!seen.has(w.code)) out.push(w);
      continue;
    }
    const ids = w.relatedIds.filter((id) => !seen.has(`${w.code}|${id}`));
    if (ids.length > 0) out.push({ code: w.code, relatedIds: ids });
  }
  return out;
}

/** 저장 거부 이유 → 저장 버튼 위 빨간 알림 본문. 제목은 "저장하지 못했어요". */
export function rejectText(reason: SaveReject): string {
  switch (reason) {
    case 'STAFF_REQUIRED':
      return '담당자를 골라 주세요.';
    case 'INVALID_INPUT':
      return '입력값을 확인해 주세요. 숨긴 고객·메뉴·담당자는 고를 수 없어요.';
    case 'INVALID_TRANSITION':
      return '이 상태로는 바꿀 수 없어요.';
    // 아래는 실제 API의 응답(설계 05 오류와 문구, 06 W3 거부 표).
    case 'NO_CHANGE':
      return '이미 같은 상태예요.';
    case 'VERSION_CONFLICT':
      return '그사이 다른 곳에서 이 예약이 바뀌었어요. 다시 열어 확인해 주세요.';
    case 'NOT_FOUND':
      return '예약을 찾을 수 없어요. 다시 불러와 주세요.';
    case 'NETWORK':
      return '저장 결과를 확인하지 못했어요. 같은 내용으로 다시 시도해 주세요.';
    case 'UNAUTHENTICATED':
      return '로그인이 끝났어요. 다시 로그인한 뒤 시도해 주세요.';
    case 'FAILED':
      return '저장하지 못했어요. 잠시 뒤 다시 시도해 주세요.';
  }
}

/** 매장 날짜 + "HH:MM" → UTC ISO(W3·W4 입력). */
export function shopIso(date: string, hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return new Date(dayStart(date) + (h * 60 + m) * MIN).toISOString();
}
