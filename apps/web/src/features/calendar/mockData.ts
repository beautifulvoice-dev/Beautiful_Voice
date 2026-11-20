// 개발용 합성 데이터. 실제 고객이 아니다(절대 규칙 8).
// 이번 주(매장 날짜 기준) 월요일을 기준으로 만들어 언제 열어도 이번 주에 예약이 보인다.
import { addDays, dayStart, shopDate, weekDays, type CalendarAppointment, type CalendarData } from './model';

/** 매장 날짜 date의 hh:mm → UTC ISO. */
const at = (date: string, hh: number, mm = 0) => new Date(dayStart(date) + (hh * 60 + mm) * 60_000).toISOString();

export function seedCalendar(today: string = shopDate(Date.now())): CalendarData {
  const [mon] = weekDays(today) as [string];
  const d = (n: number) => addDays(mon, n);
  let n = 0;
  const appt = (
    day: number,
    hh: number,
    mm: number,
    customerName: string,
    menuName: string | null,
    staffId: string,
    durationMin: number,
    prepMin: number,
    memo: string | null = null,
    status: CalendarAppointment['status'] = 'scheduled',
  ): CalendarAppointment => ({
    id: `a${++n}`,
    customerName,
    menuName,
    staffId,
    startAt: at(d(day), hh, mm),
    durationMin,
    prepMin,
    memo,
    status,
  });

  return {
    staff: [
      { id: 's1', name: '원장' },
      { id: 's2', name: '실장' },
    ],
    appointments: [
      appt(0, 10, 0, '김하늘', '수분 관리', 's1', 60, 10, '민감성 피부 — 저자극 제품', 'completed'),
      appt(0, 14, 0, '이서윤', '등 관리', 's1', 60, 20, '임산부 — 복부 관리 제외'),
      appt(0, 14, 0, '박지민', '수분 관리', 's2', 50, 10),
      appt(1, 11, 30, '최유나', null, 's1', 90, 0, '첫 방문'),
      appt(2, 13, 0, '김하늘', '수분 관리', 's1', 60, 10, null, 'no_show'),
      appt(2, 16, 0, '정다은', '리프팅', 's2', 80, 10),
      appt(3, 10, 0, '이서윤', '등 관리', 's1', 60, 20, null, 'cancelled'),
      appt(4, 15, 0, '한예린', '수분 관리', 's1', 60, 10),
      appt(5, 20, 30, '오수아', '리프팅', 's2', 80, 10, '퇴근 후 방문'),
    ],
    blocks: [
      { id: 'b1', startAt: at(d(3), 12, 0), endAt: at(d(3), 13, 0), allStaff: true, staffIds: [], memo: '점심' },
      { id: 'b2', startAt: at(d(4), 9, 0), endAt: at(d(4), 12, 0), allStaff: false, staffIds: ['s2'], memo: '실장 외출' },
    ],
  };
}
