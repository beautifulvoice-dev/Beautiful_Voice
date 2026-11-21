// 주간 보기(화면 설계서 W1): 요일 7칸 × 시간. 한 요일 칸은 담당자 수만큼 세로 줄로 나눈다(담당자별 겹침 금지라 같은 시각에 담당자마다 예약이 있을 수 있음).
// 1분 = 1px. 자정을 넘는 예약은 날마다 잘라 그린다(segmentsForDay). 영업시간 밖·휴무일은 회색으로 덮는다(결정 S2).
import { Badge } from '@seed-design/react';
import {
  dayStart,
  hourRange,
  hoursBase,
  isClosedDay,
  outsideHours,
  overlapsBlock,
  segmentsForDay,
  STATUS_TEXT,
  type CalendarAppointment,
  type CalendarData,
  type Segment,
} from '@/features/calendar/model';
import { cn } from '@/lib/utils';
import { KIND_CLASS, STATUS_CLASS, STATUS_TONE } from './styles';

const WEEKDAY = ['월', '화', '수', '목', '금', '토', '일'];

interface Props {
  days: string[];
  data: CalendarData;
  today: string;
  /** 지금 시각(ms) — 오늘 칸에 빨간 줄. 테스트에서 고정한다. */
  now: number;
  onOpen: (a: CalendarAppointment) => void;
  staffName: (id: string) => string;
}

export function WeekView({ days, data, today, now, onOpen, staffName }: Props) {
  const byDay = days.map((d) => segmentsForDay(d, data));
  const [h0, h1] = hourRange(byDay.flat(), hoursBase(days, data.businessHours));
  const top = h0 * 60;
  const height = (h1 - h0) * 60;
  const lanes: (string | null)[] = data.staff.length > 0 ? data.staff.map((s) => s.id) : [null];
  const showStaff = data.staff.length > 1;
  const appt = new Map(data.appointments.map((a) => [a.id, a]));
  const block = new Map(data.blocks.map((b) => [b.id, b]));
  const closed = days.map((d) => isClosedDay(d, data.closures));

  const place = (s: Segment) => {
    const lane = s.staffId === null ? -1 : lanes.indexOf(s.staffId);
    const w = 100 / lanes.length;
    return {
      top: s.fromMin - top,
      height: s.toMin - s.fromMin,
      left: lane < 0 ? '0%' : `${lane * w}%`,
      width: lane < 0 ? '100%' : `${w}%`,
    };
  };
  const band = (from: number, to: number) => {
    const f = Math.max(from, top);
    const t = Math.min(to, top + height);
    return f < t ? { top: f - top, height: t - f } : null;
  };

  return (
    <div className="overflow-x-auto rounded-lg border border-line">
      <div className="grid min-w-[640px] grid-cols-[3rem_repeat(7,minmax(0,1fr))]">
        <div className="border-b border-line" />
        {days.map((d, i) => (
          <div
            key={d}
            role="columnheader"
            aria-current={d === today ? 'date' : undefined}
            className={cn('border-b border-l border-line px-2 py-2 text-sm', d === today && 'font-semibold text-brand-text', closed[i] && 'bg-cal-closed')}
          >
            {WEEKDAY[i]} {Number(d.slice(8, 10))}
            {closed[i] && <span className="ml-1 text-ink-soft"> · 휴무</span>}
          </div>
        ))}

        {/* 시간 눈금 */}
        <div className="relative" style={{ height }}>
          {Array.from({ length: h1 - h0 }, (_, i) => (
            <span key={i} className="absolute right-1 -translate-y-1/2 text-xs text-ink-soft" style={{ top: i * 60 }}>
              {i === 0 ? '' : String(h0 + i).padStart(2, '0')}
            </span>
          ))}
        </div>

        {days.map((d, i) => {
          const nowMin = (now - dayStart(d)) / 60_000;
          const nowLine = d === today ? band(nowMin, nowMin + 1) : null;
          return (
            <section
              key={d}
              aria-label={`${Number(d.slice(5, 7))}월 ${Number(d.slice(8, 10))}일`}
              className="relative border-l border-line bg-[repeating-linear-gradient(to_bottom,transparent_0_59px,var(--line)_59px_60px)]"
              style={{ height }}
            >
              {/* 영업시간 밖·휴무: 예약·차단보다 아래 층 */}
              {(closed[i] ? [[0, 24 * 60] as [number, number]] : outsideHours(d, data.businessHours)).map(([f, t]) => {
                const pos = band(f, t);
                return pos && <div key={`closed-${f}`} data-kind="closed" aria-hidden className={cn('absolute inset-x-0', KIND_CLASS.closed)} style={pos} />;
              })}
              {byDay[i]!.map((s) => {
                const pos = place(s);
                const key = `${s.kind}-${s.sourceId}-${s.staffId ?? 'all'}`;
                if (s.kind === 'block') {
                  const b = block.get(s.sourceId)!;
                  return (
                    <div key={key} data-kind="block" className={cn('absolute overflow-hidden rounded-md px-1 text-xs', KIND_CLASS.block)} style={pos}>
                      관리 불가{b.memo ? ` · ${b.memo}` : ''}
                    </div>
                  );
                }
                const a = appt.get(s.sourceId)!;
                if (s.kind === 'prep') {
                  return <div key={key} data-kind="prep" aria-hidden className={cn('absolute rounded-t-md', KIND_CLASS.prep)} style={pos} />;
                }
                const overlap = overlapsBlock(a, data.blocks);
                return (
                  <button
                    key={key}
                    type="button"
                    data-kind="care"
                    data-status={a.status}
                    data-overlap={overlap || undefined}
                    onClick={() => onOpen(a)}
                    className={cn(
                      'absolute z-10 flex flex-col items-start gap-0.5 overflow-hidden rounded-md px-1.5 py-0.5 text-left text-xs leading-tight',
                      STATUS_CLASS[a.status] ?? KIND_CLASS.care,
                      overlap && 'ring-2 ring-cal-overlap ring-inset',
                    )}
                    style={pos}
                  >
                    <span className="font-semibold">{a.customerName}</span>
                    <span>{a.menuName ?? '메뉴 없음'}</span>
                    {showStaff && <span>{staffName(a.staffId)}</span>}
                    {STATUS_TONE[a.status] && (
                      <Badge.Root tone={STATUS_TONE[a.status]} variant="weak" size="medium">
                        <Badge.Label>{STATUS_TEXT[a.status]}</Badge.Label>
                      </Badge.Root>
                    )}
                    {overlap && (
                      <Badge.Root tone="critical" variant="outline" size="medium">
                        <Badge.Label>겹침</Badge.Label>
                      </Badge.Root>
                    )}
                  </button>
                );
              })}
              {nowLine && <div data-kind="now" aria-hidden className="absolute inset-x-0 z-20 h-0.5 bg-cal-now" style={{ top: nowLine.top }} />}
            </section>
          );
        })}
      </div>
    </div>
  );
}
