// ⚠️ 11/18 규칙(매장 최대 2건·자리·그대로 저장·세션 뒤 준비 시간 / 요청·확정·자동 완료) — 11/19 명세 최종판으로 대체됐다.
//    새 규칙은 booking.ts(BEA-177)·appointment-status.ts(BEA-178). apps/server의 AppointmentService(#33)가 이 파일을 쓰므로
//    2F 스키마(BEA-155) 위에서 예약 쓰기 함수(BEA-176)를 다시 만들 때 함께 지운다.
// 예약 충돌 판정 (P2-04, 분해표 C-05). 외부 의존성 없는 순수 함수.
// 규칙 출처: Linear「[P2] 2. 상세 기능 명세서」예약 규칙 R-1~R-5(2026-11-18), CAL-2·6, AC-2·3. 설계: 02-architecture §3.
// - 구간은 반열림 [start, end). 10:00~11:00과 11:00~12:00은 겹치지 않는다.
// - 세션 뒤에 준비 시간이 붙는다(기본 10분, 세션마다 바꿀 수 있음 — CAL-6). 준비 시간에는 예약을 받지 않으며
//   겹침 판정에 세션과 준비 시간을 함께 넣는다(R-3, AC-3). 이 "세션 + 준비 시간"을 점유 구간이라 부른다.
// - 일반 저장은 겹치면 거절. 원장 강제 저장("그대로 저장")도 동시 최대 2건·운영 시간·휴무·관리 불가 시간은 지킨다(R-1·R-2·R-4).
// - "자리(lane)"는 DB 배타 제약이 동시 최대 2건을 보장하게 하는 내부 번호다. 사용자에게 보이지 않는다.

export const MAX_CONCURRENT = 2;

/** 세션 뒤 준비 시간 기본값(분). 세션마다 바꿀 수 있다(CAL-6). 호출 측이 세션의 값을 넘긴다. */
export const DEFAULT_PREP_MINUTES = 10;

export interface Interval {
  start: Date;
  end: Date;
}

/** 세션 구간(start~end)과 그 뒤 준비 시간. */
export interface Session extends Interval {
  /** 세션 뒤 준비 시간(분, 0 이상). */
  prepMinutes: number;
}

export interface BookedAppointment extends Session {
  id: string;
  lane: number;
}

/**
 * 매장 영업 규칙. 시각 문자열은 **서울 시각** "HH:MM", 날짜는 서울 날짜 "YYYY-MM-DD".
 * 2A는 서울 시간대(Asia/Seoul)만 지원한다(리더 결정, PR #19 리뷰 11/18). 서울은 서머타임이 없어 UTC+9 고정이다.
 * 예약 시각(Date)은 UTC 시점이며 DB에도 UTC(timestamptz)로 저장한다. 해외 매장은 지원 범위가 넓어질 때 시간대 필드와 함께 다시 넣는다.
 */
export interface ShopSchedule {
  /** 요일(0=일 ~ 6=토)별 영업 구간. 없는 요일은 휴무. */
  weeklyHours: Partial<Record<number, { open: string; close: string }[]>>;
  /** 매장 현지 날짜 "YYYY-MM-DD"의 휴무일. */
  closedDates: string[];
  /** 관리 불가 시간(임시 차단). 예약을 받지 않는다(R-2, CAL-7). */
  blocks: Interval[];
}

export interface SaveRequest extends Session {
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

/** 점유 구간 = 세션 시작 ~ 세션 끝 + 준비 시간(R-3). 겹침·자리 배정은 이 구간으로 판단한다. */
export function occupied(s: Session): Interval {
  return { start: s.start, end: new Date(s.end.getTime() + s.prepMinutes * 60_000) };
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

  // 이후 판정은 모두 점유 구간(세션 + 준비 시간)으로 한다.
  const mine = occupied(request);
  const others = active.map((a) => ({ ...a, ...occupied(a) }));
  const direct = others.filter((a) => overlaps(a, mine));
  if (direct.length === 0) {
    return { ok: true, lane: 1, isForced: false, reassign: new Map() };
  }
  if (!request.force) {
    // 비어 있는 자리가 있어도 일반 저장은 거절한다(02 §3 리뷰 반례 1).
    return { ok: false, reason: "APPOINTMENT_CONFLICT", conflictingIds: ids(direct) };
  }

  const NEW = "\u0000new";
  const cluster = overlapCluster({ id: NEW, lane: 0, prepMinutes: 0, ...mine }, others);
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

/**
 * 운영 시간·휴무·관리 불가 시간 검사(R-2). 강제 저장으로도 넘을 수 없다.
 * ASSUMPTION: 운영 시간 안에 들어와야 하는 것은 세션이다 — 마지막 세션의 준비 시간은 마감 뒤로 넘어가도 된다.
 * ASSUMPTION: 관리 불가 시간은 점유 구간(세션 + 준비 시간)과 겹치면 안 된다 — 준비도 원장이 하는 일이다.
 */
export function checkShopRules(period: Session, schedule: ShopSchedule): RejectReason | null {
  if (!(period.start.getTime() < period.end.getTime())) return "INVALID_PERIOD";
  if (!Number.isInteger(period.prepMinutes) || period.prepMinutes < 0) return "INVALID_PERIOD";

  const startLocal = toSeoul(period.start);
  if (schedule.closedDates.includes(startLocal.date)) return "CLOSED_DAY";
  const windows = schedule.weeklyHours[startLocal.weekday] ?? [];
  if (windows.length === 0) return "CLOSED_DAY";

  // 세션 전체가 시작일(서울)의 영업 구간 하나 안에 있어야 한다. 자정을 넘는 세션은 영업시간 밖이 된다.
  // 영업 구간 경계를 실제 시각으로 바꿔 세션과 비교한다.
  const inside = windows.some((w) => {
    const open = seoulTimeToInstant(startLocal.date, w.open);
    const close = seoulTimeToInstant(startLocal.date, w.close);
    return period.start.getTime() >= open && period.end.getTime() <= close;
  });
  if (!inside) return "OUTSIDE_BUSINESS_HOURS";

  const occ = occupied(period);
  if (schedule.blocks.some((b) => overlaps(b, occ))) return "BLOCKED";
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

/** 서울 = UTC+9 고정(서머타임 없음). */
const SEOUL_OFFSET_MS = 9 * 3_600_000;

/** UTC 시각의 서울 날짜("YYYY-MM-DD")와 요일(0=일). */
export function toSeoul(at: Date): { date: string; weekday: number } {
  const shifted = new Date(at.getTime() + SEOUL_OFFSET_MS);
  return { date: shifted.toISOString().slice(0, 10), weekday: shifted.getUTCDay() };
}

/** 서울 날짜 + "HH:MM"을 실제 시각(epoch ms)으로 바꾼다. "24:00"은 다음 날 0시. */
export function seoulTimeToInstant(date: string, hhmm: string): number {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = hhmm.split(":").map(Number);
  return Date.UTC(y!, mo! - 1, d!, h!, mi!) - SEOUL_OFFSET_MS;
}
