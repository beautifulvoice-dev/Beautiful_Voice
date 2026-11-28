// 종료 전 완료 카드의 순수 판정. 저장·승인·발송은 호출자가 처리한다(설계 14(비공개)).
import type { AppointmentStatus } from "./appointment-status.ts";

export interface CompletionSnapshot {
  startAt: Date;
  durationMin: number;
  menuId: string | null;
}

export interface CompletionAppointment extends CompletionSnapshot {
  status: AppointmentStatus;
  staffId: string | null;
  cycleSeq: number;
}

export interface CompletionCardHistory {
  status: "pending" | "dismissing" | "resolved" | "dismissed" | "failed";
  reason?: string | null;
  snapshot: CompletionSnapshot;
  cycleSeq: number;
}

export interface PromotionInput {
  appointment: CompletionAppointment;
  now: Date;
  timeZone?: string;
  /** 매장 현지 날짜 시작 전에 종료된 시술을 제외한다. 기본값은 true. */
  excludePastUncompleted?: boolean;
  /** 같은 예약의 카드 이력. 이전 완료 회차의 이력도 포함한다. */
  cards: readonly CompletionCardHistory[];
}

export type PromotionReason = "PAST_UNCOMPLETED" | "ACTIVE_CARD_EXISTS" | "SAME_SNAPSHOT_HISTORY" | "SAME_CYCLE_HISTORY";

const MINUTE = 60_000;
const ACTIVE_CARD = new Set<CompletionCardHistory["status"]>(["pending", "dismissing", "resolved"]);

export function isPromotable({
  appointment, now, timeZone = "Asia/Seoul", excludePastUncompleted = true, cards,
}: PromotionInput): { promote: boolean; reason?: PromotionReason } {
  if (appointment.status !== "scheduled") return { promote: false };
  const start = appointment.startAt.getTime();
  const duration = appointment.durationMin;
  if (!Number.isFinite(start) || !Number.isFinite(now.getTime()) || !Number.isInteger(duration) || duration < 0) {
    throw new RangeError("completion requires a valid time and duration");
  }
  if (now.getTime() < start + Math.max(0, duration - 5) * MINUTE) return { promote: false };

  if (excludePastUncompleted) {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone, calendar: "iso8601", numberingSystem: "latn", year: "numeric", month: "2-digit", day: "2-digit",
    });
    const end = start + duration * MINUTE;
    if (dateKey(formatter, end) < dateKey(formatter, now)) return { promote: false, reason: "PAST_UNCOMPLETED" };
  }
  if (cards.some((card) => ACTIVE_CARD.has(card.status))) return { promote: false, reason: "ACTIVE_CARD_EXISTS" };

  const sameSnapshotHistory = cards.some(({ status, reason, snapshot }) => {
    const suppressesPromotion = (status === "dismissed" && (reason === "user" || reason === "reverted"))
      || (status === "failed" && reason === "target_changed");
    return suppressesPromotion && snapshot.startAt.getTime() === start
      && snapshot.durationMin === duration && snapshot.menuId === appointment.menuId;
  });
  if (sameSnapshotHistory) return { promote: false, reason: "SAME_SNAPSHOT_HISTORY" };
  // 018은 회차당 카드 한 장만 허용하며 시스템은 예약 변경으로 해제된 카드만 다시 연다.
  const sameCycle = cards.find((card) => card.cycleSeq === appointment.cycleSeq);
  if (sameCycle && (sameCycle.status !== "dismissed" || sameCycle.reason !== "rescheduled")) {
    return { promote: false, reason: "SAME_CYCLE_HISTORY" };
  }
  return { promote: true };
}

function dateKey(formatter: Intl.DateTimeFormat, at: Date | number): number {
  const parts = Object.fromEntries(formatter.formatToParts(at).map(({ type, value }) => [type, value]));
  return Number(parts.year) * 10_000 + Number(parts.month) * 100 + Number(parts.day);
}

export interface CompletionPass {
  id: string;
  menuId: string | null;
  isPrimary: boolean;
  isActive: boolean;
  issuedAt: Date;
  remainingSessions: number;
}

export type WalletOverride =
  | { instrument: "pass"; passId: string; quantity: number }
  | { instrument: "prepaid"; quantity: number }
  | { instrument: "skipped" };

export interface CompletionMatchInput {
  menu: { menuId: string | null; defaultPrice: number | null };
  passes: readonly CompletionPass[];
  prepaidBalance: number;
  walletOverride?: WalletOverride;
}

export type CompletionWarning =
  | { code: "MENU_MISMATCH" | "INVALID_OVERRIDE" }
  | { code: "INSUFFICIENT_BALANCE"; projectedBalance: number };

export interface CompletionMatch {
  rank: 1 | 2 | 3;
  instrument: "pass" | "prepaid" | "skipped";
  passId?: string;
  quantity: number;
  slot: "post_session" | "post_amount" | "post_general";
  warnings: CompletionWarning[];
  /** 확인이 끝나기 전에는 이 결과로 승인하지 않는다. */
  needsChoice?: true;
}

const available = (pass: CompletionPass) => pass.isActive && pass.remainingSessions > 0;

export function matchCompletion({ menu, passes, prepaidBalance, walletOverride }: CompletionMatchInput): CompletionMatch {
  if (walletOverride) {
    if (walletOverride.instrument === "skipped" || walletOverride.quantity === 0) return skipDeduction();
    const { quantity } = walletOverride;
    if (Number.isSafeInteger(quantity) && quantity > 0) {
      if (walletOverride.instrument === "prepaid" && prepaidBalance > 0) return prepaidDeduction(quantity, prepaidBalance);
      if (walletOverride.instrument === "pass") {
        const selected = passes.find((pass) => pass.id === walletOverride.passId);
        if (selected && available(selected) && selected.remainingSessions >= quantity) {
          return passDeduction(selected.id, quantity);
        }
      }
    }
    return { ...skipDeduction(), needsChoice: true, warnings: [{ code: "INVALID_OVERRIDE" }] };
  }

  const validPasses = passes.filter(available);
  if (validPasses.length > 0) {
    const matching = validPasses.filter((pass) => menu.menuId !== null && pass.menuId === menu.menuId);
    matching.sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || a.issuedAt.getTime() - b.issuedAt.getTime());
    if (matching[0]) return passDeduction(matching[0].id, 1);

    const primary = validPasses.find((pass) => pass.isPrimary);
    if (primary) return passDeduction(primary.id, 1, [{ code: "MENU_MISMATCH" }]);
    return { ...skipDeduction(), rank: 1, needsChoice: true };
  }

  const price = menu.defaultPrice ?? 0;
  return prepaidBalance > 0 && price > 0 ? prepaidDeduction(price, prepaidBalance) : skipDeduction();
}

function passDeduction(passId: string, quantity: number, warnings: CompletionWarning[] = []): CompletionMatch {
  return { rank: 1, instrument: "pass", passId, quantity, slot: "post_session", warnings };
}

function prepaidDeduction(quantity: number, balance: number): CompletionMatch {
  const projectedBalance = balance - quantity;
  const warnings: CompletionWarning[] = projectedBalance < 0 ? [{ code: "INSUFFICIENT_BALANCE", projectedBalance }] : [];
  return { rank: 2, instrument: "prepaid", quantity, slot: "post_amount", warnings };
}

function skipDeduction(): CompletionMatch {
  return { rank: 3, instrument: "skipped", quantity: 0, slot: "post_general", warnings: [] };
}

/** 차감액이 달라졌는지는 호출부에서 별도로 비교한다. */
export function sameInstrument(a: CompletionMatch, b: CompletionMatch): boolean {
  return a.rank === b.rank && a.instrument === b.instrument && a.needsChoice === b.needsChoice
    && (a.instrument !== "pass" || a.passId === b.passId);
}
