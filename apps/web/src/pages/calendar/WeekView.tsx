// 주간 보기: 요일 7칸 × 시간. 한 요일 칸은 담당자 수만큼 세로 줄로 나눈다(담당자별 겹침 금지라 같은 시각에 담당자마다 예약이 있을 수 있음).
// 1분 = 1px. 자정을 넘는 예약은 날마다 잘라 그린다(segmentsForDay).
import { hourRange, segmentsForDay, STATUS_TEXT, type CalendarAppointment, type CalendarData, type Segment } from '@/features/calendar/model';
import { cn } from '@/lib/utils';
import { KIND_CLASS } from './styles';

const WEEKDAY = ['월', '화', '수', '목', '금', '토', '일'];

interface Props {
  days: string[];
  data: CalendarData;
  today: string;
  onOpen: (a: CalendarAppointment) => void;
  staffName: (id: string) => string;
}

export function WeekView({ days, data, today, onOpen, staffName }: Props) {
  const byDay = days.map((d) => segmentsForDay(d, data));
  const [h0, h1] = hourRange(byDay.flat());
  const top = h0 * 60;
  const height = (h1 - h0) * 60;
  const lanes: (string | null)[] = data.staff.length > 0 ? data.staff.map((s) => s.id) : [null];
  const appt = new Map(data.appointments.map((a) => [a.id, a]));
  const block = new Map(data.blocks.map((b) => [b.id, b]));

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

  return (
    <div className="overflow-x-auto rounded-md border">
      <div className="grid min-w-[640px] grid-cols-[3rem_repeat(7,minmax(0,1fr))]">
        <div className="border-b" />
        {days.map((d, i) => (
          <div
            key={d}
            role="columnheader"
            aria-current={d === today ? 'date' : undefined}
            className={cn('border-b border-l px-1 py-2 text-center text-sm', d === today && 'font-semibold text-sky-700')}
          >
            {WEEKDAY[i]} {Number(d.slice(8, 10))}
          </div>
        ))}

        {/* 시간 눈금 */}
        <div className="relative" style={{ height }}>
          {Array.from({ length: h1 - h0 }, (_, i) => (
            <span key={i} className="absolute right-1 -translate-y-1/2 text-[10px] text-muted-foreground" style={{ top: i * 60 }}>
              {i === 0 ? '' : `${h0 + i}시`}
            </span>
          ))}
        </div>

        {days.map((d, i) => (
          <section
            key={d}
            aria-label={`${Number(d.slice(5, 7))}월 ${Number(d.slice(8, 10))}일`}
            className="relative border-l bg-[repeating-linear-gradient(to_bottom,transparent_0_59px,var(--border)_59px_60px)]"
            style={{ height }}
          >
            {byDay[i]!.map((s) => {
              const pos = place(s);
              const key = `${s.kind}-${s.sourceId}-${s.staffId ?? 'all'}`;
              if (s.kind === 'block') {
                const b = block.get(s.sourceId)!;
                return (
                  <div
                    key={key}
                    data-kind="block"
                    className={cn('absolute overflow-hidden rounded-sm px-1 text-[11px]', KIND_CLASS.block)}
                    style={pos}
                  >
                    차단{b.memo ? ` · ${b.memo}` : ''}
                  </div>
                );
              }
              const a = appt.get(s.sourceId)!;
              if (s.kind === 'prep') {
                return <div key={key} data-kind="prep" aria-hidden className={cn('absolute rounded-t-sm', KIND_CLASS.prep)} style={pos} />;
              }
              return (
                <button
                  key={key}
                  type="button"
                  data-kind="care"
                  onClick={() => onOpen(a)}
                  className={cn(
                    'absolute flex flex-col overflow-hidden rounded-sm border border-white/60 px-1 text-left text-[11px] leading-tight',
                    KIND_CLASS.care,
                    a.status !== 'scheduled' && 'opacity-70',
                  )}
                  style={pos}
                >
                  <span className="font-semibold">
                    {a.customerName}
                    {a.status !== 'scheduled' && ` (${STATUS_TEXT[a.status]})`}
                  </span>
                  <span>{a.menuName ?? '메뉴 없음'}</span>
                  <span>{staffName(a.staffId)}</span>
                </button>
              );
            })}
          </section>
        ))}
      </div>
    </div>
  );
}
