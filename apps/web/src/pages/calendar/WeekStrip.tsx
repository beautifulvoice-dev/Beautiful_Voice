// 폰 주 보기 위의 7일 띠(화면 설계서 W1 "폰 · 주", 디자인 HTML .wkstrip): 요일·날짜·예약 점. 날을 누르면 아래 하루 시간표와 주소 ?date=가 바뀐다.
// 좌우로 밀면 이전·다음 주(디자인에 ‹ › 버튼이 없음, 11/21 옵마 결정).
import { isClosedDay, isShown, shopDate, type CalendarData } from '@/features/calendar/model';
import { useSwipe } from '@/lib/useSwipe';
import { cn } from '@/lib/utils';

const WEEKDAY = ['월', '화', '수', '목', '금', '토', '일'];

interface Props {
  days: string[];
  data: CalendarData;
  selected: string;
  today: string;
  onPick: (date: string) => void;
  onStep: (n: 1 | -1) => void;
}

export function WeekStrip({ days, data, selected, today, onPick, onStep }: Props) {
  const swipe = useSwipe(onStep);
  const count = (d: string) => data.appointments.filter((a) => isShown(a) && shopDate(Date.parse(a.startAt)) === d).length;
  return (
    <div role="group" aria-label="날짜 고르기" className="grid grid-cols-7 gap-0.5 px-3 pt-1 pb-2" {...swipe}>
      {days.map((d, i) => {
        const n = count(d);
        const on = d === selected;
        const closed = isClosedDay(d, data.closures);
        return (
          <button
            key={d}
            type="button"
            aria-pressed={on}
            aria-current={d === today ? 'date' : undefined}
            aria-label={`${Number(d.slice(5, 7))}월 ${Number(d.slice(8, 10))}일 ${WEEKDAY[i]}요일 · ${closed ? '휴무' : `예약 ${n}건`}`}
            onClick={() => onPick(d)}
            className={cn(
              'grid justify-items-center gap-0.5 rounded-[14px] pt-1.5 pb-[7px] text-[13px]',
              on ? 'bg-brand text-on-brand' : 'text-ink-soft',
            )}
          >
            <span>{WEEKDAY[i]}</span>
            <b className={cn('text-[17px] font-bold tabular-nums', on ? 'text-on-brand' : closed ? 'text-ink-subtle' : 'text-ink')}>
              {Number(d.slice(8, 10))}
            </b>
            {/* 예약이 있는 날만 점 — 몇 건인지는 aria-label로 */}
            <i
              aria-hidden
              className={cn('size-[5px] rounded-full', n > 0 && !closed ? (on ? 'bg-on-brand' : 'bg-brand-text') : 'bg-transparent')}
            />
          </button>
        );
      })}
    </div>
  );
}
