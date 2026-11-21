// 월간 보기. 폰(디자인 HTML .mgrid): 날짜 아래 예약 수 칩, 날을 누르면 아래에 그날 목록. 좌우로 밀면 이전·다음 달.
// 웹(디자인에 그림 없음 — 설계서 W1 표): 날짜 칸마다 예약 3건까지 "시각 이름", 넘치면 "+N". 관리 불가는 회색 빗금 줄, 휴무일은 회색 + "휴무".
// 준비 시간이 있으면 준비 모양 표시를 붙인다(BEA-175: 주·월 모두 관리·준비·차단 구분 — #41 리뷰).
import { Badge } from '@seed-design/react';
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
import { useSwipe } from '@/lib/useSwipe';
import { cn } from '@/lib/utils';
import { KIND_CLASS, STATUS_TONE } from './styles';

const WEEKDAY = ['월', '화', '수', '목', '금', '토', '일'];

interface Props {
  days: string[];
  /** 'YYYY-MM' — 다른 달 날짜는 흐리게. */
  month: string;
  data: CalendarData;
  today: string;
  onOpen: (a: CalendarAppointment) => void;
  /** 폰(768px 미만): 칸엔 예약 수만, 날을 누르면 아래에 그날 목록(설계서 W1 "폰 · 월"). */
  phone?: boolean;
  /** 고른 날(주소 ?date=). 폰에서 아래 목록에 쓴다. */
  selected?: string;
  onPick?: (date: string) => void;
  onStep?: (n: 1 | -1) => void;
  staffName?: (id: string) => string;
}

/** 웹 칸에 이름을 몇 건까지 적나 — 넘치면 "+N"(설계서 W1). */
const NAMES_PER_DAY = 3;

export function MonthView({ days, month, data, today, onOpen, phone = false, selected, onPick, onStep, staffName }: Props) {
  const shown = data.appointments.filter(isShown).sort((a, b) => a.startAt.localeCompare(b.startAt));
  const dayOf = (a: CalendarAppointment) => shopDate(Date.parse(a.startAt));
  const swipe = useSwipe((n) => onStep?.(n));

  if (phone) {
    return (
      <>
        <div className="grid grid-cols-7 px-3" {...swipe}>
          {WEEKDAY.map((w) => (
            <div key={w} role="columnheader" className="py-1 text-center text-xs text-ink-subtle">
              {w}
            </div>
          ))}
          {days.map((d) => {
            const appts = shown.filter((a) => dayOf(a) === d);
            const closed = isClosedDay(d, data.closures);
            const out = d.slice(0, 7) !== month;
            const on = d === selected;
            return (
              <section key={d} aria-label={`${Number(d.slice(5, 7))}월 ${Number(d.slice(8, 10))}일`} className="border-t border-line">
                <button
                  type="button"
                  aria-pressed={on}
                  aria-current={d === today ? 'date' : undefined}
                  aria-label={`${Number(d.slice(8, 10))}일 · ${closed ? '휴무' : `예약 ${appts.length}건`}`}
                  onClick={() => onPick?.(d)}
                  className="grid min-h-[58px] w-full content-start justify-items-center gap-1 px-0.5 py-1.5 text-sm tabular-nums"
                >
                  <span
                    className={cn(
                      'grid size-[26px] place-items-center rounded-full',
                      on && 'bg-brand font-bold text-on-brand',
                      !on && out && 'text-ink-disabled',
                      !on && !out && closed && 'text-ink-subtle',
                    )}
                  >
                    {Number(d.slice(8, 10))}
                  </span>
                  {!out &&
                    (closed ? (
                      <span className="text-[11px] text-ink-subtle">휴무</span>
                    ) : (
                      appts.length > 0 && (
                        <span className="rounded-md bg-brand-weak px-[5px] text-xs font-bold text-cal-appt-text">{appts.length}</span>
                      )
                    ))}
                </button>
              </section>
            );
          })}
        </div>
        {selected && (
          <DayList
            date={selected}
            appointments={shown.filter((a) => dayOf(a) === selected)}
            blocks={data.blocks}
            onOpen={onOpen}
            staffName={staffName}
          />
        )}
      </>
    );
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-line">
      <div className="grid grid-cols-7">
        {WEEKDAY.map((w) => (
          <div key={w} role="columnheader" className="border-b border-line px-2 py-2.5 text-[13px] text-ink-soft">
            {w}
          </div>
        ))}
        {days.map((d) => {
          // 그날 관리가 시작하는 예약만 적는다(자정을 넘는 예약이 이틀에 두 번 적히지 않게).
          const appts = shown.filter((a) => dayOf(a) === d);
          const blocks = [...new Set(segmentsForDay(d, { appointments: [], blocks: data.blocks }).map((s) => s.sourceId))];
          const closed = isClosedDay(d, data.closures);
          const out = d.slice(0, 7) !== month;
          return (
            <section
              key={d}
              aria-label={`${Number(d.slice(5, 7))}월 ${Number(d.slice(8, 10))}일`}
              className={cn(
                'min-h-28 border-b border-l border-line p-1.5 text-[13px] [&:nth-child(7n+8)]:border-l-0',
                closed && 'bg-cal-closed',
              )}
            >
              <p
                className={cn(
                  'mb-1 px-1 text-sm font-bold tabular-nums',
                  out ? 'text-ink-disabled' : closed ? 'text-ink-subtle' : 'text-ink',
                  d === today && 'text-brand-text',
                )}
                aria-current={d === today ? 'date' : undefined}
              >
                {Number(d.slice(8, 10))}
                {closed && <span className="ml-1 text-xs font-semibold text-ink-subtle">휴무</span>}
              </p>
              <ul className="flex flex-col gap-0.5">
                {blocks.map((id) => {
                  const b = data.blocks.find((x) => x.id === id)!;
                  return (
                    <li key={id} data-kind="block" className={cn('truncate rounded-md px-1.5', KIND_CLASS.block)}>
                      관리 불가{b.memo ? ` · ${b.memo}` : ''}
                    </li>
                  );
                })}
                {appts.slice(0, NAMES_PER_DAY).map((a) => {
                  const overlap = overlapsBlock(a, data.blocks);
                  return (
                    <li key={a.id}>
                      <button
                        type="button"
                        data-kind="care"
                        data-overlap={overlap || undefined}
                        onClick={() => onOpen(a)}
                        className={cn(
                          'w-full truncate rounded-md px-1.5 text-left',
                          a.status === 'completed'
                            ? 'bg-cal-done text-cal-done-text'
                            : a.status === 'no_show'
                              ? 'bg-cal-noshow text-cal-noshow-text'
                              : KIND_CLASS.care,
                          // 관리 불가와 겹친 예약은 주간처럼 빨간 테두리 + "겹침"(R50, #50 리뷰)
                          overlap && 'bg-paper shadow-[inset_0_0_0_2px_var(--cal-overlap)]',
                        )}
                      >
                        {/* 좁은 칸에서도 잘리지 않게 준비 표시는 글자 앞의 작은 빗금 칸으로. 글자는 화면 읽기·툴팁용. */}
                        {a.prepMin > 0 && (
                          <span
                            data-kind="prep"
                            title={`준비 ${shopTime(Date.parse(a.startAt) - a.prepMin * 60_000)}부터 ${a.prepMin}분`}
                            className={cn('mr-1 inline-block h-2 w-2.5 rounded-l-sm align-middle', KIND_CLASS.prep)}
                          >
                            <span className="sr-only">준비 {a.prepMin}분</span>
                          </span>
                        )}
                        <span className="tabular-nums">{shopTime(a.startAt)}</span> <b className="font-bold text-ink">{a.customerName}</b>
                        {a.status !== 'scheduled' && ` · ${STATUS_TEXT[a.status]}`}
                        {overlap && <span className="ml-1 font-semibold text-cal-overlap">겹침</span>}
                      </button>
                    </li>
                  );
                })}
                {appts.length > NAMES_PER_DAY && <li className="px-1.5 text-ink-soft">+{appts.length - NAMES_PER_DAY}</li>}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}

const WEEKDAY_SHORT = ['일', '월', '화', '수', '목', '금', '토'];

/** 폰 월 보기 아래: 고른 날의 예약 목록(시각 · 고객 · 메뉴 · 담당자 · 상태, 디자인 .lrow). 누르면 예약 시트. */
function DayList({
  date,
  appointments,
  blocks,
  onOpen,
  staffName,
}: {
  date: string;
  appointments: CalendarAppointment[];
  blocks: CalendarData['blocks'];
  onOpen: (a: CalendarAppointment) => void;
  staffName?: (id: string) => string;
}) {
  const label = `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}(${WEEKDAY_SHORT[new Date(`${date}T00:00:00Z`).getUTCDay()]})`;
  return (
    <section aria-label={`${label} 예약`} className="flex flex-col gap-3.5 px-5 pt-3.5">
      <div className="flex items-baseline justify-between pt-1 text-[15px] font-bold">
        <h3>{label}</h3>
        <span className="text-sm font-medium text-ink-soft">예약 {String(appointments.length).padStart(2, '0')}</span>
      </div>
      {appointments.length === 0 && <p className="py-4 text-center text-sm text-ink-soft">예약이 없어요</p>}
      <ul className="flex flex-col">
        {appointments.map((a) => (
          <li key={a.id} className="border-b border-line last:border-b-0">
            <button type="button" onClick={() => onOpen(a)} className="flex w-full items-center gap-3 py-3 text-left">
              <span className="w-12 shrink-0 text-[15px] tabular-nums">{shopTime(a.startAt)}</span>
              <span className="grid min-w-0 flex-1 gap-0.5">
                <b className="text-base">{a.customerName}</b>
                <span className="text-sm text-ink-soft">
                  {a.menuName ?? '메뉴 없음'}
                  {staffName ? ` · ${staffName(a.staffId)}` : ''}
                </span>
              </span>
              {STATUS_TONE[a.status] && (
                <Badge.Root tone={STATUS_TONE[a.status]} variant="weak" size="large">
                  <Badge.Label>{STATUS_TEXT[a.status]}</Badge.Label>
                </Badge.Root>
              )}
              {overlapsBlock(a, blocks) && <span className="shrink-0 font-semibold text-cal-overlap">겹침</span>}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
