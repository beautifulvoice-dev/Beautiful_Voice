// 주간 보기(화면 설계서 W1, 디자인 HTML .wk·.tl). 웹: 시간 × 7일 격자(1시간 48px). 폰: 고른 하루 시간표(1시간 64px, 위 7일 띠는 WeekStrip).
// 한 날 칸은 담당자 수만큼 세로 줄로 나눈다(담당자별 겹침 금지라 같은 시각에 담당자마다 예약이 있을 수 있음).
// 자정을 넘는 예약은 날마다 잘라 그린다(segmentsForDay). 영업시간 밖·휴무일은 회색으로 덮는다(결정 S2).
// 빈 칸을 누르면 그 시각(15분 단위)·담당자로 예약 넣기(W3)를 연다(설계서 W1 "빈 칸 누르기").
import type { Closure } from '@bv/contracts';
import { Badge } from '@seed-design/react';
import type { MouseEvent } from 'react';
import {
  dayStart,
  hourRange,
  hoursBase,
  isClosedDay,
  outsideHours,
  overlapsBlock,
  segmentsForDay,
  shopTime,
  STATUS_TEXT,
  type CalendarAppointment,
  type CalendarData,
  type Segment,
} from '@/features/calendar/model';
import { cn } from '@/lib/utils';
import { KIND_CLASS, OVERLAP_CLASS, STATUS_CLASS, STATUS_TONE } from './styles';

const WEEKDAY = ['월', '화', '수', '목', '금', '토', '일'];
/** 0=월 … 6=일 */
const weekdayOf = (d: string) => (new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7;
const MIN = 60_000;

interface Props {
  days: string[];
  data: CalendarData;
  today: string;
  /** 지금 시각(ms) — 오늘 칸에 빨간 줄. 테스트에서 고정한다. */
  now: number;
  onOpen: (a: CalendarAppointment) => void;
  /** 담당자가 2명 이상이면 칸에 담당자 이름(화면 읽기용 — 눈으로는 칸 위치·담당자 칩 안내로 구분, 디자인). */
  staffName?: (id: string) => string;
  /** 빈 칸 누르기: 그 날, 그 날 0시부터 분(15분 단위), 담당자(칸이 나뉘었을 때). */
  onEmpty?: (date: string, minute: number, staffId: string | null) => void;
  /** 폰 하루 시간표(디자인 .tl) — 1시간 64px, 시간 글자 "10:00". */
  phone?: boolean;
}

/** 휴무 이름: 매주 휴무면 "정기 휴무", 그 밖은 "휴무"(디자인 "수 · 정기 휴무"). */
function closedLabel(date: string, closures: readonly Closure[]): string {
  const weekday = weekdayOf(date) + 1;
  return closures.some((c) => c.kind === 'weekly' && c.weekday === weekday) ? '정기 휴무' : '휴무';
}

export function WeekView({ days, data, today, now, onOpen, staffName, onEmpty, phone = false }: Props) {
  const hourPx = phone ? 64 : 48;
  const px = (min: number) => (min * hourPx) / 60;
  const byDay = days.map((d) => segmentsForDay(d, data));
  const [h0, h1] = hourRange(byDay.flat(), hoursBase(days, data.businessHours));
  const top = h0 * 60;
  const height = px((h1 - h0) * 60);
  const lanes: (string | null)[] = data.staff.length > 0 ? data.staff.map((s) => s.id) : [null];
  const appt = new Map(data.appointments.map((a) => [a.id, a]));
  const block = new Map(data.blocks.map((b) => [b.id, b]));
  const closed = days.map((d) => isClosedDay(d, data.closures));
  // 칸 사이 띄움(디자인): 웹은 바깥 3px·사이 2px, 폰은 바깥 4px·사이 6px.
  const [edge, gap] = phone ? [4, 6] : [3, 2];

  const horizontal = (staffId: string | null) => {
    const n = lanes.length;
    const i = staffId === null ? -1 : lanes.indexOf(staffId);
    if (i < 0) return { left: `${edge}px`, width: `calc(100% - ${edge * 2}px)` };
    const w = 100 / n;
    const l = i === 0 ? edge : gap / 2;
    const r = i === n - 1 ? edge : gap / 2;
    return { left: `calc(${i * w}% + ${l}px)`, width: `calc(${w}% - ${l + r}px)` };
  };
  const vertical = (from: number, to: number) => {
    const f = Math.max(from, top);
    const t = Math.min(to, h1 * 60);
    return f < t ? { top: px(f - top), height: px(t - f) } : null;
  };

  const empty = (d: string) => (e: MouseEvent<HTMLDivElement>) => {
    if (!onEmpty || e.target !== e.currentTarget) return;
    const box = e.currentTarget.getBoundingClientRect();
    const minute = top + Math.floor(((e.clientY - box.top) * 60) / hourPx / 15) * 15;
    const lane =
      lanes.length > 1 ? lanes[Math.min(lanes.length - 1, Math.floor(((e.clientX - box.left) / box.width) * lanes.length))]! : null;
    onEmpty(d, minute, lane);
  };

  const dayColumn = (d: string, i: number) => {
    const nowMin = (now - dayStart(d)) / MIN;
    const nowPos = d === today ? vertical(nowMin, nowMin + 1) : null;
    return (
      <section
        key={d}
        aria-label={`${Number(d.slice(5, 7))}월 ${Number(d.slice(8, 10))}일`}
        className={cn('relative', !phone && 'border-l border-line', !phone && closed[i] && 'bg-cal-closed')}
        style={{ height }}
      >
        {/* 영업시간 밖·휴무: 예약·차단보다 아래 층. 휴무일(웹)은 칸 전체가 회색이라 띠를 따로 깔지 않는다. */}
        {(closed[i] ? (phone ? [[0, 24 * 60] as [number, number]] : []) : outsideHours(d, data.businessHours)).map(([f, t]) => {
          const pos = vertical(f, t);
          return (
            pos && (
              <div key={`closed-${f}`} data-kind="closed" aria-hidden className={cn('absolute inset-x-0', KIND_CLASS.closed)} style={pos} />
            )
          );
        })}
        {!phone && closed[i] && (
          <span data-kind="closed" className="absolute inset-x-0 top-[40%] text-center text-sm font-semibold text-ink-subtle">
            {closedLabel(d, data.closures)}
          </span>
        )}
        {/* 시간 줄 */}
        {Array.from({ length: h1 - h0 - 1 }, (_, k) => (
          <div key={k} aria-hidden className="absolute inset-x-0 h-px bg-line" style={{ top: px((k + 1) * 60) }} />
        ))}
        {/* 빈 칸 누르기 층: 줄·회색 위, 예약·차단 아래 */}
        {onEmpty && <div aria-hidden data-kind="empty" className="absolute inset-0 cursor-pointer" onClick={empty(d)} />}
        {byDay[i]!.map((s) => renderSegment(s))}
        {nowPos && (
          <div data-kind="now" aria-hidden className="absolute right-0 left-0 z-[3] h-0.5 bg-cal-now" style={{ top: nowPos.top }}>
            <span className="absolute -top-[3px] -left-1 size-2 rounded-full bg-cal-now" />
          </div>
        )}
      </section>
    );
  };

  const renderSegment = (s: Segment) => {
    const box = vertical(s.fromMin, s.toMin);
    if (!box) return null;
    const pos = { ...box, ...horizontal(s.staffId) };
    const key = `${s.kind}-${s.sourceId}-${s.staffId ?? 'all'}`;
    if (s.kind === 'block') {
      const b = block.get(s.sourceId)!;
      return (
        <div
          key={key}
          data-kind="block"
          className={cn(
            'absolute grid content-start gap-px overflow-hidden rounded-lg px-[7px] py-[5px] text-[13px] leading-[1.3]',
            KIND_CLASS.block,
          )}
          style={pos}
        >
          <b className="font-bold text-ink">관리 불가{b.allStaff && lanes.length > 1 ? ' · 전체' : ''}</b>
          {b.memo && <span>{b.memo}</span>}
        </div>
      );
    }
    const a = appt.get(s.sourceId)!;
    if (s.kind === 'prep') {
      return <div key={key} data-kind="prep" aria-hidden className={cn('absolute rounded-t-md', KIND_CLASS.prep)} style={pos} />;
    }
    const overlap = overlapsBlock(a, data.blocks);
    const start = Date.parse(a.startAt);
    const tone = STATUS_TONE[a.status];
    return (
      <button
        key={key}
        type="button"
        data-kind="care"
        data-status={a.status}
        data-overlap={overlap || undefined}
        onClick={() => onOpen(a)}
        className={cn(
          'absolute z-[1] grid content-start justify-items-start gap-px overflow-hidden rounded-lg px-[7px] py-[5px] text-left text-[13px] leading-[1.3]',
          STATUS_CLASS[a.status] ?? KIND_CLASS.care,
          overlap && OVERLAP_CLASS,
        )}
        style={pos}
      >
        {lanes.length > 1 && staffName && <span className="sr-only">{staffName(a.staffId)} · </span>}
        <b className="text-sm font-bold text-ink">
          {a.customerName}
          {phone && overlap && a.menuName ? ` · ${a.menuName}` : ''}
        </b>
        {phone ? (
          <>
            {!overlap && a.status !== 'no_show' && <span>{a.menuName ?? '메뉴 없음'}</span>}
            {!tone && !overlap && <span>{`${shopTime(start)}–${shopTime(start + a.durationMin * MIN)}`}</span>}
            {tone && (
              <Badge.Root tone={tone} variant="weak" size="large" className="mt-0.5">
                <Badge.Label>{STATUS_TEXT[a.status]}</Badge.Label>
              </Badge.Root>
            )}
            {overlap && (
              <Badge.Root tone="critical" variant="weak" size="large" className="mt-0.5">
                <Badge.Label>겹침</Badge.Label>
              </Badge.Root>
            )}
          </>
        ) : (
          // 웹 칸은 좁아 이름 + 시작 시각(완료·노쇼면 상태 낱말)만. 메뉴·담당자는 누르면 패널에서.
          <span>
            {tone ? STATUS_TEXT[a.status] : shopTime(start)}
            {overlap && <span className="sr-only"> · 겹침</span>}
            <span className="sr-only"> · {a.menuName ?? '메뉴 없음'}</span>
          </span>
        )}
      </button>
    );
  };

  if (phone) {
    // 폰 하루 시간표: 날짜는 위 7일 띠에 있으므로 머리엔 담당자별 칸 이름만(2명 이상일 때)
    return (
      <div className="isolate">
        {lanes.length > 1 && (
          <div
            role="row"
            className="grid gap-1.5 border-b border-line pt-1.5 pr-3.5 pb-1.5 pl-3 text-[13px] font-bold text-ink-soft"
            style={{ gridTemplateColumns: `40px repeat(${lanes.length}, minmax(0, 1fr))` }}
          >
            <span />
            {data.staff.map((st) => (
              <span key={st.id} role="columnheader">
                {st.name}
              </span>
            ))}
          </div>
        )}
        <div className="relative mt-2.5 mr-3.5 ml-3" style={{ height }}>
          {Array.from({ length: h1 - h0 }, (_, k) => (
            <span
              key={k}
              aria-hidden
              className="absolute left-0 w-[34px] -translate-y-1/2 text-right text-xs text-ink-subtle tabular-nums"
              style={{ top: px(k * 60) }}
            >
              {String(h0 + k).padStart(2, '0')}:00
            </span>
          ))}
          <div aria-hidden className="absolute top-0 right-0 left-10 h-px bg-line" />
          <div className="absolute inset-y-0 right-0 left-10">{dayColumn(days[0]!, 0)}</div>
        </div>
      </div>
    );
  }

  return (
    // isolate: 칸 안의 z-index(예약·지금 줄)가 머리줄·아래 탭과 겨루지 않게 이 표 안에 가둔다.
    <div className="isolate overflow-x-auto rounded-2xl border border-line">
      {/* 7일이면 768~1279px에서 가로로 넘긴다(설계 D2). */}
      <div className="grid min-w-[640px]" style={{ gridTemplateColumns: `52px repeat(${days.length}, minmax(0, 1fr))` }}>
        <div className="border-b border-line" />
        {days.map((d, i) => (
          <div
            key={d}
            role="columnheader"
            aria-current={d === today ? 'date' : undefined}
            className={cn('grid border-b border-l border-line px-2 py-2.5 text-[13px] text-ink-soft', closed[i] && 'bg-cal-closed')}
          >
            <span>
              {WEEKDAY[weekdayOf(d)]}
              {d === today ? ' · 오늘' : closed[i] ? ` · ${closedLabel(d, data.closures)}` : ''}
            </span>
            <b className={cn('text-lg text-ink tabular-nums', d === today && 'text-brand-text')}>{Number(d.slice(8, 10))}</b>
          </div>
        ))}

        {/* 시간 눈금 "09" */}
        <div className="relative" style={{ height }}>
          {Array.from({ length: h1 - h0 }, (_, k) => (
            <span
              key={k}
              className="absolute right-2 -translate-y-1/2 text-xs text-ink-subtle tabular-nums"
              style={{ top: k === 0 ? 8 : px(k * 60) }}
            >
              {String(h0 + k).padStart(2, '0')}
            </span>
          ))}
        </div>
        {days.map(dayColumn)}
      </div>
    </div>
  );
}
