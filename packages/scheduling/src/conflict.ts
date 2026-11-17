// 예약 충돌 판정 (P2-04, 분해표 C-05). 외부 의존성 없는 순수 함수.
// 규칙 출처: 02-architecture §3 "충돌 보장", Linear PD-11~15.
// - 구간은 반열림 [start, end). 10:00~11:00과 11:00~12:00은 겹치지 않는다.
// - 겹침 판정은 시술 시간만 쓴다. 준비·정리 시간은 넣지 않는다(PD-13).
// - 일반 저장은 겹치면 거절. 원장 강제 저장도 동시 최대 2건·영업시간·휴무·임시 차단은 지킨다(PD-11·14·15).
// - "자리(lane)"는 DB 배타 제약이 동시 최대 2건을 보장하게 하는 내부 번호다. 사용자에게 보이지 않는다.

export const MAX_CONCURRENT = 2;

export interface Interval {
  start: Date;
  end: Date;
}

export interface BookedAppointment extends Interval {
  id: string;
  lane: number;
}

/** 매장 영업 규칙. 시각 문자열은 매장 현지 시각 "HH:MM". */
export interface ShopSchedule {
  timeZone: string;
  /** 요일(0=일 ~ 6=토)별 영업 구간. 없는 요일은 휴무. */
  weeklyHours: Partial<Record<number, { open: string; close: string }[]>>;
  /** 매장 현지 날짜 "YYYY-MM-DD"의 휴무일. */
  closedDates: string[];
  /** 임시 차단(PD-15). ASSUMPTION: 차단 시간에는 강제 저장도 불가 — 명세서로 확인. */
  blocks: Interval[];
}

export interface SaveRequest extends Interval {
  /** 원장이 "강제 저장"을 골랐는지. AI 제안은 스스로 true를 고를 수 없다. */
  force: boolean;
}

export type RejectReason =
  | "INVALID_PERIOD"
  | "CLOSED_DAY"
  | "OUTSIDE_BUSINESS_HOURS"
  | "BLOCKED"
  | "APPOINTMENT_CONFLICT"
  | "CAPACITY_EXCEEDED";

export type Decision =
  | {
      ok: true;
      lane: number;
      isForced: boolean;
      /** 강제 저장으로 자리를 옮겨야 하는 기존 예약 (id → 새 자리). */
      reassign: Map<string, number>;
    }
  | {
      ok: false;
      reason: RejectReason;
      /** 판정에 걸린 기존 예약 id. */
      conflictingIds: string[];
    };

export function overlaps(a: Interval, b: Interval): boolean {
  return a.start.getTime() < b.end.getTime() && b.start.getTime() < a.end.getTime();
}

/**
 * 새 예약(또는 시간을 옮기는 예약)을 저장할 수 있는지 판정하고 자리를 정한다.
 *
 * 호출 규약 — 저장 서비스(C-07)가 지키고 서비스 테스트로 확인한다:
 * - `active`에는 **같은 매장(shop_id)** 의 예약만 넘긴다. 이 함수는 매장을 구분하지 않는다(절대 규칙 5).
 * - `active`에는 확정·완료 예약만 넘긴다. 시간을 옮기는 예약은 **자기 자신을 빼고** 넘긴다
 *   (빼지 않으면 자기 자신과 겹쳐 거절된다).
 * - 매장 단위 잠금을 건 트랜잭션 안에서 부르고, `reassign`과 새 자리를 같은 트랜잭션에서 저장한다.
 */
export function decideSave(
  request: SaveRequest,
  schedule: ShopSchedule,
  active: BookedAppointment[],
): Decision {
  const ruleViolation = checkShopRules(request, schedule);
  if (ruleViolation) return { ok: false, reason: ruleViolation, conflictingIds: [] };

  const direct = active.filter((a) => overlaps(a, request));
  if (direct.length === 0) {
    return { ok: true, lane: 1, isForced: false, reassign: new Map() };
  }
  if (!request.force) {
    // 비어 있는 자리가 있어도 일반 저장은 거절한다(02 §3 리뷰 반례 1).
    return { ok: false, reason: "APPOINTMENT_CONFLICT", conflictingIds: ids(direct) };
  }

  const NEW = "\u0000new";
  const cluster = overlapCluster({ id: NEW, lane: 0, ...request }, active);
  const lanes = assignLanes(cluster);
  if (!lanes) {
    return { ok: false, reason: "CAPACITY_EXCEEDED", conflictingIds: ids(direct) };
  }
  const reassign = new Map<string, number>();
  for (const a of cluster) {
    const lane = lanes.get(a.id)!;
    if (a.id !== NEW && lane !== a.lane) reassign.set(a.id, lane);
  }
  return { ok: true, lane: lanes.get(NEW)!, isForced: true, reassign };
}

/** 영업시간·휴무·임시 차단 검사. 강제 저장으로도 넘을 수 없다. */
export function checkShopRules(period: Interval, schedule: ShopSchedule): RejectReason | null {
  if (!(period.start.getTime() < period.end.getTime())) return "INVALID_PERIOD";

  const startLocal = toLocal(period.start, schedule.timeZone);
  if (schedule.closedDates.includes(startLocal.date)) return "CLOSED_DAY";
  const windows = schedule.weeklyHours[startLocal.weekday] ?? [];
  if (windows.length === 0) return "CLOSED_DAY";

  // 예약 전체가 같은 현지 날짜의 영업 구간 하나 안에 있어야 한다. 자정을 넘는 예약은 영업시간 밖으로 본다.
  const from = startLocal.minutes;
  const to = from + (period.end.getTime() - period.start.getTime()) / 60_000;
  const inside = windows.some((w) => from >= toMinutes(w.open) && to <= toMinutes(w.close));
  if (!inside) return "OUTSIDE_BUSINESS_HOURS";

  if (schedule.blocks.some((b) => overlaps(b, period))) return "BLOCKED";
  return null;
}

/** 새 예약과 이어서 겹치는(전이적으로 연결된) 예약 묶음. 새 예약 포함. */
function overlapCluster(seed: BookedAppointment, active: BookedAppointment[]): BookedAppointment[] {
  const cluster = [seed];
  const rest = [...active];
  for (let i = 0; i < cluster.length; i++) {
    for (let j = rest.length - 1; j >= 0; j--) {
      if (overlaps(cluster[i]!, rest[j]!)) cluster.push(...rest.splice(j, 1));
    }
  }
  return cluster;
}

/**
 * 시작 시각 순으로 비어 있는 가장 낮은 자리에 넣는다(구간 분할 탐욕법 — 필요한 최소 자리 수를 보장).
 * MAX_CONCURRENT를 넘는 자리가 필요하면 null.
 */
function assignLanes(items: BookedAppointment[]): Map<string, number> | null {
  const sorted = [...items].sort(
    (a, b) => a.start.getTime() - b.start.getTime() || a.end.getTime() - b.end.getTime(),
  );
  const laneFreeAt: number[] = []; // 자리별로 마지막 예약이 끝나는 시각
  const result = new Map<string, number>();
  for (const a of sorted) {
    let lane = laneFreeAt.findIndex((freeAt) => freeAt <= a.start.getTime());
    if (lane === -1) {
      if (laneFreeAt.length >= MAX_CONCURRENT) return null;
      lane = laneFreeAt.length;
      laneFreeAt.push(0);
    }
    laneFreeAt[lane] = a.end.getTime();
    result.set(a.id, lane + 1);
  }
  return result;
}

function ids(list: { id: string }[]): string[] {
  return list.map((a) => a.id);
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h! * 60 + m!;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** UTC 시각을 매장 현지 날짜·요일·자정 이후 분(소수 포함)으로 바꾼다. */
function toLocal(at: Date, timeZone: string): { date: string; weekday: number; minutes: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  const minutes =
    Number(parts.hour) * 60 + Number(parts.minute) + Number(parts.second) / 60 + at.getUTCMilliseconds() / 60_000;
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: WEEKDAYS[parts.weekday!]!,
    minutes,
  };
}
