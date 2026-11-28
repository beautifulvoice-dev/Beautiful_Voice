// 주간 보기(화면 설계서 W1, 디자인 HTML .wk·.tl). 웹: 시간 × 7일 격자(1시간 48px). 폰: 고른 하루 시간표(1시간 64px, 위 7일 띠는 WeekStrip).
// 한 날 칸은 담당자 수만큼 세로 줄로 나눈다(같은 시각에 담당자마다 예약이 있을 수 있음).
// 담당자 미지정 예약은 담당자가 2명 이상일 때 맨 오른쪽 "미지정" 열 — 보이는 날에 미지정 예약이 있을 때만(옵마 11/27).
// 시술 칸 바로 아래에 정리 칸(rev.3.1 — 정리 시간은 시술 뒤).
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
  hasOverlap,
  segmentsForDay,
  shopTime,
  STATUS_TEXT,
  type CalendarAppointment,
  type CalendarData,
  type Segment,
  type CalendarBlock,
  UNASSIGNED_LANE,
} from '@/features/calendar/model';
import { blockPeriodText } from './BlockPanel';
import { cn } from '@/lib/utils';
import { KIND_CLASS, OVERLAP_CLASS, STATUS_CLASS, STATUS_TONE } from './styles';

const WEEKDAY = ['월', '화', '수', '목', '금', '토', '일'];
/** 0=월 … 6=일 */
const weekdayOf = (d: string) => (new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7;
const MIN = 60_000;
/** 칸 안 배지: 글자는 14px 그대로, 위아래 여백·높이만 줄여 1시간 칸(웹 48px)에 이름 + 배지가 들어가게. */
const CARD_BADGE = '!min-h-0 !py-0 !leading-[18px]';

/**
 * 설계서 §9.1 "가장 작은 글자 14px"의 예외 하나(카본 11/22 B안 승인): 캘린더 주 보기의 **작은 칸**만 글자 12px.
 * 작은 칸 = 웹에서 담당자 2명 이상이라 반쪽 폭인 칸, 또는 높이가 maxHeightPx보다 낮은 칸. 그 밖의 칸·화면은 14px.
 * 판정 기준은 여기 한 곳에 둔다. 12px 클래스는 아래 두 상수에만 쓴다(test/font-size.test.ts가 이 둘만 허용).
 */
export const SMALL_CARD = { webMinLanes: 2, maxHeightPx: 48 } as const;
/**
 * 웹 담당자 칸(반쪽 칸) 최소 폭: 12px 굵은 이름 4글자(≈48px) + 칸 안 여백 14px, 배지(완료·노쇼·겹침 ≈ 40px)도 들어가는 폭.
 * 날 칸이 이보다 좁아지면 격자를 가로로 넘긴다(설계 D2) — 이름이 말줄임되거나 배지가 칸 밖으로 잘리지 않게(#70 리뷰).
 */
export const WEB_LANE_MIN_PX = 64; // 48px = 웹 1시간 칸 높이. 이보다 낮으면(1시간 미만) 작은 칸
const SMALL_CARD_TEXT = 'text-xs leading-[15px]';
const SMALL_CARD_BADGE = '!text-xs !leading-[15px]';

interface Props {
  days: string[];
  data: CalendarData;
  today: string;
  /** 지금 시각(ms) — 오늘 칸에 빨간 줄. 테스트에서 고정한다. */
  now: number;
  onOpen: (a: CalendarAppointment) => void;
  /** 담당자가 2명 이상이면 칸에 담당자 이름(화면 읽기용 — 눈으로는 칸 위치·담당자 칩 안내로 구분, 디자인). */
  staffName?: (id: string | null) => string;
  /** 빈 칸 누르기: 그 날, 그 날 0시부터 분(15분 단위), 담당자(칸이 나뉘었을 때). */
  onEmpty?: (date: string, minute: number, staffId: string | null) => void;
  /** 관리 불가 칸 누르기 → 보기·지우기(W4). 없으면 칸은 누를 수 없다. */
  onOpenBlock?: (b: CalendarBlock) => void;
  /** 폰 하루 시간표(디자인 .tl) — 1시간 64px, 시간 글자 "10:00". */
  phone?: boolean;
}

/** 휴무 이름: 매주 휴무면 "정기 휴무", 그 밖은 "휴무"(디자인 "수 · 정기 휴무"). */
function closedLabel(date: string, closures: readonly Closure[]): string {
  const weekday = weekdayOf(date) + 1;
  return closures.some((c) => c.kind === 'weekly' && c.weekday === weekday) ? '정기 휴무' : '휴무';
}

export function WeekView({ days, data, today, now, onOpen, staffName, onEmpty, onOpenBlock, phone = false }: Props) {
  const hourPx = phone ? 64 : 48;
  const px = (min: number) => (min * hourPx) / 60;
  const byDay = days.map((d) => segmentsForDay(d, data));
  const [h0, h1] = hourRange(byDay.flat(), hoursBase(days, data.businessHours));
  const top = h0 * 60;
  const height = px((h1 - h0) * 60);
  const unassigned = byDay.some((segs) => segs.some((s) => s.staffId === UNASSIGNED_LANE));
  const staffLanes = data.staff.length > 0 ? data.staff.map((s) => s.id) : [];
  const lanes: (string | null)[] =
    staffLanes.length >= 2 ? [...staffLanes, ...(unassigned ? [UNASSIGNED_LANE] : [])] : staffLanes.length === 1 ? staffLanes : [null];
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
    onEmpty(d, minute, lane === UNASSIGNED_LANE ? null : lane);
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
    // 작은 칸(SMALL_CARD): 반쪽 폭(웹·담당자 2명↑·담당자 한 명 칸)이거나 낮은 칸이면 12px
    const small = (!phone && lanes.length >= SMALL_CARD.webMinLanes && s.staffId !== null) || box.height < SMALL_CARD.maxHeightPx;
    const fs = small ? SMALL_CARD_TEXT : 'text-sm leading-[1.3]';
    const badgeClass = cn(CARD_BADGE, small && SMALL_CARD_BADGE);
    if (s.kind === 'block') {
      const b = block.get(s.sourceId)!;
      const Tag = onOpenBlock ? 'button' : 'div';
      return (
        <Tag
          key={key}
          data-kind="block"
          {...(onOpenBlock ? { type: 'button' as const, onClick: () => onOpenBlock(b), 'aria-label': `관리 불가 시간 ${blockPeriodText(b)}${b.memo ? ` · ${b.memo}` : ''}` } : {})}
          className={cn('absolute flex flex-col gap-px overflow-hidden rounded-lg text-left [&>*]:shrink-0 px-[7px] py-[5px]', fs, KIND_CLASS.block)}
          style={pos}
        >
          <b className="truncate font-bold text-ink">관리 불가{b.allStaff && lanes.length > 1 ? ' · 전체' : ''}</b>
          {b.memo && <span className="truncate">{b.memo}</span>}
        </Tag>
      );
    }
    const a = appt.get(s.sourceId)!;
    if (s.kind === 'cleanup') {
      return <div key={key} data-kind="cleanup" aria-hidden className={cn('absolute rounded-b-md', KIND_CLASS.cleanup)} style={pos} />;
    }
    const overlap = hasOverlap(a, data);
    const start = Date.parse(a.startAt);
    const tone = STATUS_TONE[a.status];
    const badges = (tone || overlap) && (
      <span className="flex shrink-0 gap-0.5">
        {tone && (
          <Badge.Root tone={tone} variant="weak" size="large" className={badgeClass}>
            <Badge.Label>{STATUS_TEXT[a.status]}</Badge.Label>
          </Badge.Root>
        )}
        {overlap && (
          <Badge.Root tone="critical" variant="weak" size="large" className={badgeClass}>
            <Badge.Label>겹침</Badge.Label>
          </Badge.Root>
        )}
      </span>
    );
    const menu = a.menuName ?? '메뉴 없음';
    // 칸 모양(카본 디자인, 11/22 옵마):
    // - 폰 하루 시간표·웹 담당자 1명(넓은 칸): 1줄 = 이름 + 상태 배지, 2줄 = 메뉴 · 시각 한 줄(메뉴만 말줄임).
    // - 웹 담당자 2명 이상(좁은 칸): 1줄 = 이름만(배지에 밀려 잘리지 않게), 2줄 = 예정이면 시작 시각, 완료·노쇼·겹침이면 배지.
    // 어느 경우든 줄바꿈 없이, 칸 높이를 넘는 줄은 칸 안에서 잘린다(overflow-hidden).
    const wide = phone || lanes.length === 1;
    const timeText = phone ? shopTime(start) : `${shopTime(start)}–${shopTime(start + a.durationMin * MIN)}`;
    return (
      <button
        key={key}
        type="button"
        data-kind="care"
        data-status={a.status}
        data-overlap={overlap || undefined}
        onClick={() => onOpen(a)}
        className={cn(
          // 세로로 줄을 쌓고(flex-col), 칸 높이에 다 못 들어가는 줄은 옆 열로 넘겨(flex-wrap + 줄 폭 100%) 칸 밖에서 통째로 숨긴다 —
          // 반쯤 잘린 배지·글자가 보이지 않게. 첫 줄(이름)은 늘 첫 열에 남는다.
          '@container absolute z-[1] flex flex-col flex-wrap content-start gap-x-4 gap-y-px overflow-hidden [&>*]:w-full [&>*]:shrink-0 rounded-lg px-[7px] py-1 text-left',
          fs,
          STATUS_CLASS[a.status] ?? KIND_CLASS.care,
          overlap && OVERLAP_CLASS,
        )}
        style={pos}
      >
        {lanes.length > 1 && staffName && <span className="sr-only">{staffName(a.staffId)} · </span>}
        {wide ? (
          <>
            {/* 칸 폭 8rem 이상: 이름 옆에 배지. 그보다 좁으면 배지는 따로 아랫줄 — 이름이 배지에 밀려 잘리지 않고,
                칸 높이에 못 들어가면 그 줄이 통째로 숨는다(반쯤 잘린 배지 없음). 폰 칸은 늘 8rem보다 넓다. */}
            <span data-part="name" className="flex min-w-0 items-center gap-1 whitespace-nowrap">
              <b className="min-w-0 truncate font-bold text-ink">{a.customerName}</b>
              {badges && <span className="hidden shrink-0 @[8rem]:flex">{badges}</span>}
            </span>
            {badges && <span className="flex @[8rem]:hidden">{badges}</span>}
            {/* 메뉴만 말줄임. 시각은 칸 폭이 9rem 이상일 때(폰·넓은 웹) — 좁은 웹 칸은 시각이 격자 위치로 보이므로 메뉴를 남긴다. */}
            <span data-part="menu-time" className="flex min-w-0 whitespace-nowrap">
              <span className="min-w-0 truncate">{menu}</span>
              <span className={cn('shrink-0 tabular-nums', !phone && 'hidden @[9rem]:inline')}>{`\u00a0· ${timeText}`}</span>
            </span>
          </>
        ) : (
          <>
            <b data-part="name" className="truncate font-bold whitespace-nowrap text-ink">
              {a.customerName}
            </b>
            <span className="flex min-w-0 items-center gap-0.5 whitespace-nowrap">
              {/* 예정이면 시작 시각, 완료·노쇼·겹침이면 배지만(좁은 칸에 둘 다 넣으면 시각이 "1…"로 잘린다) */}
              {badges || <span className="truncate tabular-nums">{shopTime(start)}</span>}
              <span className="sr-only"> · {menu}</span>
            </span>
          </>
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
            className="grid gap-1.5 border-b border-line pt-1.5 pr-3.5 pb-1.5 pl-3 text-sm font-bold text-ink-soft"
            style={{ gridTemplateColumns: `40px repeat(${lanes.length}, minmax(0, 1fr))` }}
          >
            <span />
            {lanes.map((id) => (
              <span key={id} role="columnheader">
                {id === UNASSIGNED_LANE ? '미지정' : data.staff.find((st) => st.id === id)?.name}
              </span>
            ))}
          </div>
        )}
        <div className="relative mt-2.5 mr-3.5 ml-3" style={{ height }}>
          {Array.from({ length: h1 - h0 }, (_, k) => (
            <span
              key={k}
              aria-hidden
              className="absolute left-0 w-9 -translate-y-1/2 text-right text-sm text-ink-subtle tabular-nums"
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
      <div
        className="grid min-w-[640px]"
        style={{
          gridTemplateColumns: `52px repeat(${days.length}, minmax(${lanes.length > 1 ? lanes.length * WEB_LANE_MIN_PX + 8 : 0}px, 1fr))`,
        }}
      >
        <div className="border-b border-line" />
        {days.map((d, i) => (
          <div
            key={d}
            role="columnheader"
            aria-current={d === today ? 'date' : undefined}
            className={cn('grid border-b border-l border-line px-2 py-2.5 text-sm text-ink-soft', closed[i] && 'bg-cal-closed')}
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
              className="absolute right-2 -translate-y-1/2 text-sm text-ink-subtle tabular-nums"
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
