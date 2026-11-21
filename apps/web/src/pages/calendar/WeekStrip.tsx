// 폰 주 보기 위의 7일 띠(화면 설계서 W1 "폰 · 주"): 요일·날짜·예약 점. 날을 누르면 아래 하루 시간표와 주소 ?date=가 바뀐다.
import { isClosedDay, isShown, shopDate, type CalendarData } from '@/features/calendar/model';
import { cn } from '@/lib/utils';

const WEEKDAY = ['월', '화', '수', '목', '금', '토', '일'];

interface Props {
  days: string[];
  data: CalendarData;
  selected: string;
  today: string;
  onPick: (date: string) => void;
}

export function WeekStrip({ days, data, selected, today, onPick }: Props) {
  const count = (d: string) => data.appointments.filter((a) => isShown(a) && shopDate(Date.parse(a.startAt)) === d).length;
  return (
    <div role="group" aria-label="날짜 고르기" className="grid grid-cols-7 gap-1">
      {days.map((d, i) => {
        const n = count(d);
        const on = d === selected;
        const closed = isClosedDay(d, data.closures);
        return (
          <button
            key={d}
            type="button"
            aria-pressed={on}
            aria-label={`${Number(d.slice(5, 7))}월 ${Number(d.slice(8, 10))}일 ${WEEKDAY[i]}요일 · ${closed ? '휴무' : `예약 ${n}건`}`}
            onClick={() => onPick(d)}
            className={cn(
              'flex flex-col items-center gap-0.5 rounded-xl py-1.5',
              on ? 'bg-brand text-on-brand' : d === today ? 'text-brand-text' : 'text-ink',
              closed && !on && 'text-ink-soft',
            )}
          >
            <span className="text-sm">{WEEKDAY[i]}</span>
            <span className="text-lg font-semibold leading-none">{Number(d.slice(8, 10))}</span>
            {/* 예약이 있는 날만 점 — 몇 건인지는 aria-label로 */}
            <span aria-hidden className={cn('size-1.5 rounded-full', n > 0 ? (on ? 'bg-on-brand' : 'bg-brand') : 'bg-transparent')} />
          </button>
        );
      })}
    </div>
  );
}
