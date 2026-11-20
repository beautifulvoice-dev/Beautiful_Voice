// 캘린더 보기(BEA-175, 기능 2A-3.1)의 데이터 모양과 화면 배치 규칙. 저장·검사는 하지 않는다(그건 예약 쓰기 BEA-160·177).
// 시간은 UTC로 받고 매장 시간대로 그린다(절대 규칙 7).
// ASSUMPTION: 매장 시간대는 Asia/Seoul 고정(ADR-0007). 서울은 일광절약시간이 없어 +9시간으로 계산한다.
// 다른 시간대 매장이 생기면 여기만 바꾼다.

/** 예약 상태(명세 01 §2.2). */
export type AppointmentStatus = 'scheduled' | 'completed' | 'cancelled' | 'no_show' | 'voided';

export const STATUS_TEXT: Record<AppointmentStatus, string> = {
  scheduled: '예정', // 화면 표기 통일(주드 11/20): 상태는 '예정', 기능 문구(예약 등록·상세)는 '예약'
  completed: '완료',
  cancelled: '취소',
  no_show: '노쇼',
  voided: '되돌림',
};

/** 캘린더에 그릴 예약 한 건. 고객·메뉴·담당자는 이름까지 붙여서 받는다(카드에 보이므로). */
export interface CalendarAppointment {
  id: string;
  customerName: string;
  menuName: string | null;
  staffId: string;
  /** 관리 시작(UTC ISO). */
  startAt: string;
  durationMin: number;
  /** 준비 시간 — 관리 시작 앞에 붙는다. */
  prepMin: number;
  memo: string | null;
  status: AppointmentStatus;
}

/** 캘린더 차단. allStaff면 매장 전체, 아니면 staffIds의 담당자만 막는다(명세 01 §2.2). */
export interface CalendarBlock {
  id: string;
  startAt: string;
  endAt: string;
  allStaff: boolean;
  staffIds: string[];
  memo: string | null;
}

export interface Staff {
  id: string;
  name: string;
}

export interface CalendarData {
  staff: Staff[];
  appointments: CalendarAppointment[];
  blocks: CalendarBlock[];
}

// ── 날짜 계산(매장 날짜 'YYYY-MM-DD') ─────────────────────────────

const MIN = 60_000;
const DAY = 86_400_000;
const SHOP_OFFSET = 9 * 60 * MIN;

/** 매장 날짜 0시의 UTC 시각(ms). */
export function dayStart(date: string): number {
  return Date.parse(`${date}T00:00:00Z`) - SHOP_OFFSET;
}

/** UTC 시각 → 매장 날짜. */
export function shopDate(ms: number): string {
  return new Date(ms + SHOP_OFFSET).toISOString().slice(0, 10);
}

export function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
}

/** 0=월 … 6=일. */
function weekdayIndex(date: string): number {
  return (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
}

/** ASSUMPTION: 주는 월요일에 시작한다 — 와이어프레임(11/21)에서 확인. */
export function weekDays(date: string): string[] {
  const monday = addDays(date, -weekdayIndex(date));
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

/** 달력 칸: 그 달 1일이 든 주 월요일부터 말일이 든 주 일요일까지. */
export function monthGrid(date: string): string[] {
  const first = `${date.slice(0, 7)}-01`;
  const next = addDays(first, 32).slice(0, 7);
  const last = addDays(`${next}-01`, -1);
  const days: string[] = [];
  for (let d = weekDays(first)[0]!; d <= weekDays(last)[6]!; d = addDays(d, 1)) days.push(d);
  return days;
}

export function addMonths(date: string, n: number): string {
  const [y, m] = date.split('-').map(Number) as [number, number];
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  return t.toISOString().slice(0, 10);
}

// ── 화면 배치 ─────────────────────────────────────────────

/** 관리(care)·준비(prep)·차단(block)을 다르게 그린다(BEA-175 완료 조건). */
export type SegmentKind = 'care' | 'prep' | 'block';

export interface Segment {
  kind: SegmentKind;
  /** 예약 id 또는 차단 id. */
  sourceId: string;
  /** 그 날 0시부터 몇 분째에서 시작·끝나는지(날을 넘으면 잘라 낸다). */
  fromMin: number;
  toMin: number;
  /** 담당자 줄. null이면 모든 담당자에 걸친다(매장 전체 차단). */
  staffId: string | null;
}

/** 캘린더에 보이는 예약: 취소·되돌림은 점유가 아니라 칸을 차지하지 않는다. */
export function isShown(a: CalendarAppointment): boolean {
  // ASSUMPTION: 취소·되돌림 예약은 캘린더에 그리지 않는다(점유에서 빠짐, 명세 01 §2.2). 고객 방문 기록에서 본다.
  return a.status !== 'cancelled' && a.status !== 'voided';
}

/** 점유 = [시작 − 준비, 시작 + 관리) (명세 01 §2.2, 결정 R33). */
export function appointmentParts(a: CalendarAppointment): { kind: 'prep' | 'care'; from: number; to: number }[] {
  const start = Date.parse(a.startAt);
  const parts: { kind: 'prep' | 'care'; from: number; to: number }[] = [];
  if (a.prepMin > 0) parts.push({ kind: 'prep', from: start - a.prepMin * MIN, to: start });
  parts.push({ kind: 'care', from: start, to: start + a.durationMin * MIN });
  return parts;
}

/** 하루치 조각. 자정을 넘는 예약·차단은 그 날 안쪽만 남긴다. */
export function segmentsForDay(date: string, data: Pick<CalendarData, 'appointments' | 'blocks'>): Segment[] {
  const d0 = dayStart(date);
  const d1 = d0 + DAY;
  const out: Segment[] = [];
  const clip = (kind: SegmentKind, sourceId: string, from: number, to: number, staffId: string | null) => {
    const f = Math.max(from, d0);
    const t = Math.min(to, d1);
    if (f < t) out.push({ kind, sourceId, fromMin: (f - d0) / MIN, toMin: (t - d0) / MIN, staffId });
  };
  for (const b of data.blocks) {
    const from = Date.parse(b.startAt);
    const to = Date.parse(b.endAt);
    if (b.allStaff) clip('block', b.id, from, to, null);
    else for (const s of b.staffIds) clip('block', b.id, from, to, s);
  }
  for (const a of data.appointments.filter(isShown)) {
    for (const p of appointmentParts(a)) clip(p.kind, a.id, p.from, p.to, a.staffId);
  }
  return out;
}

/** 주간 보기의 세로 범위(분). 기본 9~21시, 그 밖 조각이 있으면 시간 단위로 넓힌다. */
export function hourRange(segments: readonly Segment[], base: [number, number] = [9, 21]): [number, number] {
  let [from, to] = base;
  for (const s of segments) {
    from = Math.min(from, Math.floor(s.fromMin / 60));
    to = Math.max(to, Math.ceil(s.toMin / 60));
  }
  return [from, to];
}

/** 'HH:MM' (매장 시각). */
export function shopTime(iso: string | number): string {
  const ms = typeof iso === 'number' ? iso : Date.parse(iso);
  return new Date(ms + SHOP_OFFSET).toISOString().slice(11, 16);
}

/** 예약 카드의 시간 글자: "13:40 준비 · 14:00–15:00". */
export function appointmentTimeText(a: CalendarAppointment): string {
  const start = Date.parse(a.startAt);
  const care = `${shopTime(start)}–${shopTime(start + a.durationMin * MIN)}`;
  return a.prepMin > 0 ? `${shopTime(start - a.prepMin * MIN)} 준비 · ${care}` : care;
}
