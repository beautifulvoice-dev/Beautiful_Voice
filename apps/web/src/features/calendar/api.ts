// 캘린더 화면이 데이터를 가져오는 창구. 화면은 이 인터페이스만 알고, 예약 API(BEA-176)·설정 API(#45)가 생기면 구현만 바꾼다.
import { createContext, useContext } from 'react';
import { dayStart, type CalendarData } from './model';

/** 가짜 저장소에 넣는 값. 영업시간·휴무를 빼면 "안 넣은 매장"으로 본다. */
export type CalendarSeed = Omit<CalendarData, 'businessHours' | 'closures'> & Partial<Pick<CalendarData, 'businessHours' | 'closures'>>;
import { seedCalendar } from './mockData';

export interface CalendarApi {
  /** 매장 날짜 from ~ to(마지막 날 포함). 즉 from 0시 ~ to 다음 날 0시 사이에 점유·차단이 걸치는 것. 예약 API 계약도 같은 뜻으로 둔다. */
  range(from: string, to: string): Promise<CalendarData>;
}

/**
 * 서버 API 전 임시 저장소(브라우저 메모리).
 * ASSUMPTION: 한 매장 데이터만 담는다. 매장 격리(shop_id)는 실제 API가 로그인 정보로 보장한다.
 */
export function createMemoryCalendarApi(seed: CalendarSeed = seedCalendar()): CalendarApi {
  return {
    async range(from, to) {
      const f = dayStart(from);
      const t = dayStart(to) + 86_400_000;
      const hit = (s: number, e: number) => s < t && e > f;
      return {
        staff: seed.staff.map((s) => ({ ...s })),
        appointments: seed.appointments
          .filter((a) => {
            const start = Date.parse(a.startAt);
            return hit(start - a.prepMin * 60_000, start + a.durationMin * 60_000);
          })
          .map((a) => ({ ...a })),
        blocks: seed.blocks.filter((b) => hit(Date.parse(b.startAt), Date.parse(b.endAt))).map((b) => ({ ...b })),
        businessHours: seed.businessHours ?? null,
        closures: (seed.closures ?? []).map((c) => ({ ...c })),
      };
    },
  };
}

const CalendarApiContext = createContext<CalendarApi | null>(null);
export const CalendarApiProvider = CalendarApiContext.Provider;

const defaultApi = createMemoryCalendarApi();
export function useCalendarApi(): CalendarApi {
  return useContext(CalendarApiContext) ?? defaultApi;
}
