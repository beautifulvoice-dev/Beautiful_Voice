// 영업시간 화면이 쓰는 값 바꾸기. 저장 모양(계약 BusinessHours)과 화면 입력 모양(요일마다 켜기·여는·닫는 시각)을 오간다.
// ASSUMPTION(해나 11/21 결정): 화면에서는 요일마다 구간 1개, 30분 단위로 고른다. 점심시간 같은 2번째 구간은 나중에.
import type { BusinessHours } from '@bv/contracts';
import { WEEKDAY_TEXT, type Weekday } from './messages';

type Window = { open: string; close: string };

export interface DayDraft {
  isOpen: boolean;
  open: string;
  close: string;
  /** 화면이 고치지 않는 2번째 이후 구간. 다른 곳에서 넣었더라도 저장할 때 지우지 않고 그대로 보낸다. */
  extra: Window[];
}
export type HoursDraft = Record<Weekday, DayDraft>;

export const WEEKDAYS: Weekday[] = [1, 2, 3, 4, 5, 6, 7];

/** 아직 영업시간을 넣지 않은 매장에 처음 보여 줄 예시 값(설계 메모 2단계 추천). */
const EXAMPLE: Window = { open: '10:00', close: '20:00' };

/** 00:00 ~ 24:00, 30분 간격. 여는 시각에는 24:00, 닫는 시각에는 00:00이 없다. */
const HALF_HOURS = Array.from({ length: 49 }, (_, i) => `${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`);
export const OPEN_TIMES = HALF_HOURS.slice(0, -1);
export const CLOSE_TIMES = HALF_HOURS.slice(1);

/** 고를 수 있는 시각 목록. 저장된 값이 30분 단위가 아니면(예 10:15) 지우지 않도록 목록에 끼워 넣는다. */
export function timeOptions(base: readonly string[], current: string): string[] {
  return base.includes(current) ? [...base] : [...base, current].sort();
}

export function toDraft(hours: BusinessHours | null): HoursDraft {
  const draft = {} as HoursDraft;
  for (const day of WEEKDAYS) {
    // 영업시간을 아직 안 넣었으면 모든 요일을 예시 값으로 켜 둔다. 넣었는데 요일이 없으면 쉬는 날.
    const windows = hours === null ? [EXAMPLE] : (hours[String(day) as keyof BusinessHours] ?? []);
    const [first, ...extra] = windows;
    draft[day] = first ? { isOpen: true, open: first.open, close: first.close, extra } : { isOpen: false, ...EXAMPLE, extra: [] };
  }
  return draft;
}

/** 쉬는 날은 키를 뺀다(검사 함수와 같은 약속: 빈 요일 = 그 요일 영업 안 함). */
export function fromDraft(draft: HoursDraft): BusinessHours {
  const out: BusinessHours = {};
  for (const day of WEEKDAYS) {
    const d = draft[day];
    if (d.isOpen) out[String(day) as keyof BusinessHours] = [{ open: d.open, close: d.close }, ...d.extra];
  }
  return out;
}

/** 설정 목록에 보일 한 줄. 예: "화~일", "월·수·금", "아직 안 넣음". */
export function hoursSummary(hours: BusinessHours | null): string {
  if (hours === null) return '아직 안 넣음';
  const open = WEEKDAYS.filter((d) => (hours[String(d) as keyof BusinessHours]?.length ?? 0) > 0);
  if (open.length === 0) return '모두 쉬는 날';
  const first = open[0]!;
  const last = open[open.length - 1]!;
  const continuous = last - first + 1 === open.length;
  if (continuous && open.length >= 3) return `${WEEKDAY_TEXT[first]}~${WEEKDAY_TEXT[last]}`;
  return open.map((d) => WEEKDAY_TEXT[d]).join('·');
}

/** 저장 오류 위치("2[0]" 또는 "2")에서 요일만 꺼낸다. 화면에서 그 요일 줄에 문구를 단다. */
export function weekdayAt(at: string | undefined): Weekday | null {
  const m = at?.match(/^([1-7])(?:\[|$)/u);
  return m ? (Number(m[1]) as Weekday) : null;
}
