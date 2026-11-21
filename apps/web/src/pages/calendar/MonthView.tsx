// 월간 보기: 날짜 칸마다 그날 예약(관리 시작 시각·고객)과 관리 불가 시간을 한 줄씩. 휴무일은 회색 + "휴무". 준비 시간이 있으면 준비 모양 표시를 붙인다
// (BEA-175: 주·월 모두 관리·준비·차단 구분 — #41 리뷰). 길이까지 그린 모양은 주간 보기에서 본다.
import {
  isClosedDay,
  isShown,
  overlapsBlock,
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
          <div key={w} role="columnheader" className="border-b py-1 text-center text-xs text-ink-soft">
            {w}
          </div>
        ))}
        {days.map((d) => {
          // 그날 관리가 시작하는 예약만 적는다(자정을 넘는 예약이 이틀에 두 번 적히지 않게).
          const appts = shown.filter((a) => shopDate(Date.parse(a.startAt)) === d);
          const blocks = [...new Set(segmentsForDay(d, { appointments: [], blocks: data.blocks }).map((s) => s.sourceId))];
          const closed = isClosedDay(d, data.closures);
          return (
            <section
              key={d}
              aria-label={`${Number(d.slice(5, 7))}월 ${Number(d.slice(8, 10))}일`}
              className={cn(
                'min-h-20 border-b border-l border-line p-1 text-xs [&:nth-child(7n+8)]:border-l-0',
                (d.slice(0, 7) !== month || closed) && 'bg-cal-closed text-ink-soft',
              )}
            >
              <p className={cn('mb-0.5 text-xs', d === today && 'font-semibold text-brand-text')} aria-current={d === today ? 'date' : undefined}>
                {Number(d.slice(8, 10))}
                {closed && <span className="ml-1">휴무</span>}
              </p>
              <ul className="flex flex-col gap-0.5">
                {blocks.map((id) => {
                  const b = data.blocks.find((x) => x.id === id)!;
                  return (
                    <li key={id} data-kind="block" className={cn('truncate rounded-sm px-1', KIND_CLASS.block)}>
                      관리 불가{b.memo ? ` · ${b.memo}` : ''}
                    </li>
                  );
                })}
                {appts.map((a) => (
                  <li key={a.id}>
                    <button
                      type="button"
                      data-kind="care"
                      data-overlap={overlapsBlock(a, data.blocks) || undefined}
                      onClick={() => onOpen(a)}
                      className={cn(
                        'w-full truncate rounded-sm px-1 text-left hover:bg-brand-weak',
                        // 관리 불가와 겹친 예약은 주간처럼 빨간 테두리 + "겹침"(R50, #50 리뷰)
                        overlapsBlock(a, data.blocks) && 'ring-1 ring-cal-overlap ring-inset',
                      )}
                    >
                      {/* 좁은 칸에서도 잘리지 않게 준비 표시는 글자 앞의 작은 빗금 칸으로. 글자는 화면 읽기·툴팁용. */}
                      {a.prepMin > 0 && (
                        <span
                          data-kind="prep"
                          title={`준비 ${shopTime(Date.parse(a.startAt) - a.prepMin * 60_000)}부터 ${a.prepMin}분`}
                          className={cn('mr-0.5 inline-block h-2 w-2.5 rounded-l-sm align-middle', KIND_CLASS.prep)}
                        >
                          <span className="sr-only">준비 {a.prepMin}분</span>
                        </span>
                      )}
                      <span aria-hidden className={cn('mr-1 inline-block size-2 rounded-full align-middle', KIND_CLASS.care)} />
                      {shopTime(a.startAt)} {a.customerName}
                      {a.status !== 'scheduled' && ` (${STATUS_TEXT[a.status]})`}
                      {overlapsBlock(a, data.blocks) && <span className="ml-1 font-semibold text-cal-overlap">겹침</span>}
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
