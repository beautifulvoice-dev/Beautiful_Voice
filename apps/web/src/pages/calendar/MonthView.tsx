// 월간 보기: 날짜 칸마다 그날 예약(시작 시각·고객)과 차단을 한 줄씩. 관리·준비 길이는 주간 보기에서 본다.
import {
  isShown,
  segmentsForDay,
  shopDate,
  shopTime,
  STATUS_TEXT,
  type CalendarAppointment,
  type CalendarData,
} from '@/features/calendar/model';
import { cn } from '@/lib/utils';
import { KIND_CLASS } from './styles';

const WEEKDAY = ['월', '화', '수', '목', '금', '토', '일'];

interface Props {
  days: string[];
  /** 'YYYY-MM' — 다른 달 날짜는 흐리게. */
  month: string;
  data: CalendarData;
  today: string;
  onOpen: (a: CalendarAppointment) => void;
}

export function MonthView({ days, month, data, today, onOpen }: Props) {
  const shown = data.appointments.filter(isShown).sort((a, b) => a.startAt.localeCompare(b.startAt));
  return (
    <div className="rounded-md border">
      <div className="grid grid-cols-7">
        {WEEKDAY.map((w) => (
          <div key={w} role="columnheader" className="border-b py-1 text-center text-xs text-muted-foreground">
            {w}
          </div>
        ))}
        {days.map((d) => {
          // 그날 관리가 시작하는 예약만 적는다(자정을 넘는 예약이 이틀에 두 번 적히지 않게).
          const appts = shown.filter((a) => shopDate(Date.parse(a.startAt)) === d);
          const blocks = [...new Set(segmentsForDay(d, { appointments: [], blocks: data.blocks }).map((s) => s.sourceId))];
          return (
            <section
              key={d}
              aria-label={`${Number(d.slice(5, 7))}월 ${Number(d.slice(8, 10))}일`}
              className={cn('min-h-20 border-b border-l p-1 text-[11px] [&:nth-child(7n+8)]:border-l-0', d.slice(0, 7) !== month && 'bg-muted/50 text-muted-foreground')}
            >
              <p className={cn('mb-0.5 text-xs', d === today && 'font-semibold text-sky-700')} aria-current={d === today ? 'date' : undefined}>
                {Number(d.slice(8, 10))}
              </p>
              <ul className="flex flex-col gap-0.5">
                {blocks.map((id) => {
                  const b = data.blocks.find((x) => x.id === id)!;
                  return (
                    <li key={id} data-kind="block" className={cn('truncate rounded-sm px-1', KIND_CLASS.block)}>
                      차단{b.memo ? ` · ${b.memo}` : ''}
                    </li>
                  );
                })}
                {appts.map((a) => (
                  <li key={a.id}>
                    <button
                      type="button"
                      data-kind="care"
                      onClick={() => onOpen(a)}
                      className="w-full truncate rounded-sm px-1 text-left hover:bg-accent"
                    >
                      <span aria-hidden className={cn('mr-1 inline-block size-2 rounded-full', KIND_CLASS.care)} />
                      {shopTime(a.startAt)} {a.customerName}
                      {a.status !== 'scheduled' && ` (${STATUS_TEXT[a.status]})`}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}
