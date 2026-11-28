import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  isPromotable, matchCompletion, sameInstrument,
  type CompletionCardHistory, type CompletionMatchInput, type CompletionPass, type PromotionInput,
} from "../src/completion.ts";

const at = (time: string, date = "2026-12-01") => new Date(`${date}T${time}+09:00`);
const appointment = {
  status: "scheduled", startAt: at("14:00:00"), durationMin: 60, menuId: "menu-a",
  staffId: null, cycleSeq: 2,
} as const;
const promotion = (input: Partial<PromotionInput> = {}) =>
  isPromotable({ appointment, now: at("14:55:00"), cards: [], ...input });
const history = (input: Partial<CompletionCardHistory>): CompletionCardHistory =>
  ({ status: "dismissed", reason: "user", snapshot: appointment, cycleSeq: 1, ...input });

describe("완료 카드 승격", () => {
  it("시술 종료 5분 전 직전에는 대기하고 정각에는 승격하며 정리 시간은 무시한다", () => {
    const withCleanup = { ...appointment, cleanupMin: 30 };
    assert.deepEqual(promotion({ appointment: withCleanup, now: at("14:54:59.999") }), { promote: false });
    assert.deepEqual(promotion({ appointment: withCleanup }), { promote: true });
  });

  it("5분 미만 시술은 시작 시각부터, 예정 상태만 승격한다", () => {
    const short = { ...appointment, durationMin: 3 };
    assert.equal(promotion({ appointment: short, now: at("13:59:59") }).promote, false);
    assert.equal(promotion({ appointment: short, now: at("14:00:00") }).promote, true);
    for (const status of ["completed", "cancelled", "no_show", "voided"] as const) {
      assert.deepEqual(promotion({ appointment: { ...short, status } }), { promote: false });
    }
  });

  it("서울 자정에 정확히 끝나는 시술은 포함하고 직전에 끝난 시술은 제외한다", () => {
    const now = at("00:01:00");
    const overnight = { ...appointment, startAt: at("23:30:00", "2026-11-30"), durationMin: 30 };
    assert.deepEqual(promotion({ appointment: overnight, now }), { promote: true });
    assert.deepEqual(promotion({ appointment: { ...overnight, durationMin: 29 }, now }),
      { promote: false, reason: "PAST_UNCOMPLETED" });
    assert.deepEqual(promotion({ appointment: { ...overnight, durationMin: 29 }, now, timeZone: "UTC" }), { promote: true });
    assert.deepEqual(promotion({ appointment: { ...overnight, durationMin: 29 }, now, excludePastUncompleted: false }), { promote: true });
    assert.deepEqual(promotion({ appointment: overnight, now: at("23:55:00", "2026-11-30") }), { promote: true });
  });

  it("회차가 달라도 예약에 활성 카드가 있으면 승격하지 않는다", () => {
    for (const status of ["pending", "dismissing", "resolved"] as const) {
      assert.deepEqual(promotion({ cards: [history({ status })] }), { promote: false, reason: "ACTIVE_CARD_EXISTS" });
    }
  });

  it("같은 스냅샷의 보류·정정·대상 변경 실패 이력은 승격을 차단한다", () => {
    const blocked = [
      history({ reason: "user" }), history({ reason: "reverted" }),
      history({ status: "failed", reason: "target_changed" }),
    ];
    for (const card of blocked) {
      const sameInstant = { ...card.snapshot, startAt: new Date("2026-12-01T05:00:00Z") };
      assert.deepEqual(promotion({ cards: [{ ...card, snapshot: sameInstant }] }),
        { promote: false, reason: "SAME_SNAPSHOT_HISTORY" });
      for (const changed of [{ startAt: at("13:00:00") }, { durationMin: 59 }, { menuId: "other" }]) {
        assert.deepEqual(promotion({ cards: [card], appointment: { ...appointment, ...changed } }), { promote: true });
      }
    }
    assert.deepEqual(promotion({ cards: [history({ reason: "rescheduled" })] }), { promote: true });
  });
});

const pass = (id: string, fields: Partial<CompletionPass> = {}): CompletionPass => ({
  id, menuId: "menu-a", isPrimary: false, isActive: true, issuedAt: at("10:00:00"),
  remainingSessions: 3, ...fields,
});
const match = (input: Partial<CompletionMatchInput> = {}) =>
  matchCompletion({ menu: { menuId: "menu-a", defaultPrice: 20_000 }, passes: [], prepaidBalance: 0, ...input });
const skipped = { rank: 3, instrument: "skipped", quantity: 0, slot: "post_general", warnings: [] };

describe("완료 카드 차감안", () => {
  it("메뉴 일치권에서 대표권 우선, 대표권이 없으면 먼저 발급된 권종을 선택한다", () => {
    const early = pass("early", { issuedAt: at("09:00:00") });
    const later = pass("later");
    const primary = pass("primary", { isPrimary: true, issuedAt: at("11:00:00") });
    assert.deepEqual(match({ passes: [later, early, primary] }), {
      rank: 1, instrument: "pass", passId: "primary", quantity: 1, slot: "post_session", warnings: [],
    });
    assert.equal(match({ passes: [later, early] }).passId, "early");
    assert.equal(match({ passes: [pass("other-primary", { menuId: "menu-b", isPrimary: true }), early] }).passId, "early");
  });

  it("일치권이 없으면 유효 대표권과 메뉴 불일치 경고를 반환한다", () => {
    assert.deepEqual(match({ passes: [pass("primary", { menuId: "menu-b", isPrimary: true })] }), {
      rank: 1, instrument: "pass", passId: "primary", quantity: 1, slot: "post_session",
      warnings: [{ code: "MENU_MISMATCH" }],
    });
  });

  it("일치권과 대표권이 모두 없으면 선불 잔액이 있어도 원장 선택을 요청한다", () => {
    const noMenu = pass("unlinked", { menuId: null });
    const plan = match({ menu: { menuId: null, defaultPrice: 20_000 }, passes: [noMenu], prepaidBalance: 30_000 });
    assert.deepEqual(plan, { ...skipped, rank: 1, needsChoice: true });
  });

  it("숨긴 횟수권과 잔여 0회는 제외하고 선불 기본가를 적용한다", () => {
    const passes = [pass("hidden", { isActive: false }), pass("empty", { remainingSessions: 0, isPrimary: true })];
    assert.deepEqual(match({ passes, prepaidBalance: 40_000 }), {
      rank: 2, instrument: "prepaid", quantity: 20_000, slot: "post_amount", warnings: [],
    });
  });

  it("선불 잔액보다 큰 자동 차감액을 유지하고 차감 후 잔액을 경고한다", () => {
    assert.deepEqual(match({ prepaidBalance: 5_000 }), {
      rank: 2, instrument: "prepaid", quantity: 20_000, slot: "post_amount",
      warnings: [{ code: "INSUFFICIENT_BALANCE", projectedBalance: -15_000 }],
    });
  });

  it("잔액·권종이 없거나 기본가가 null·0이면 차감을 생략한다", () => {
    assert.deepEqual(match(), skipped);
    for (const defaultPrice of [null, 0]) {
      assert.deepEqual(match({ menu: { menuId: "menu-a", defaultPrice }, prepaidBalance: 30_000 }), skipped);
    }
  });

  it("유효한 원장 선택은 자동 매칭보다 우선하고 수량을 유지한다", () => {
    const passes = [pass("auto", { isPrimary: true }), pass("chosen", { menuId: "menu-b" })];
    assert.deepEqual(match({ passes, walletOverride: { instrument: "pass", passId: "chosen", quantity: 2 } }), {
      rank: 1, instrument: "pass", passId: "chosen", quantity: 2, slot: "post_session", warnings: [],
    });
    assert.deepEqual(match({ passes, prepaidBalance: 10_000, walletOverride: { instrument: "prepaid", quantity: 12_000 } }), {
      rank: 2, instrument: "prepaid", quantity: 12_000, slot: "post_amount",
      warnings: [{ code: "INSUFFICIENT_BALANCE", projectedBalance: -2_000 }],
    });
  });

  it("사라짐·숨김·잔여 부족이나 잘못된 수량은 다른 수단으로 자동 차감하지 않는다", () => {
    const passes = [pass("hidden", { isActive: false }), pass("low", { remainingSessions: 1 }), pass("auto")];
    for (const passId of ["missing", "hidden", "low"]) {
      assert.deepEqual(match({ passes, walletOverride: { instrument: "pass", passId, quantity: 2 } }),
        { ...skipped, needsChoice: true, warnings: [{ code: "INVALID_OVERRIDE" }] });
    }
    for (const quantity of [-1, 1.5]) {
      assert.equal(match({ prepaidBalance: 10_000, walletOverride: { instrument: "prepaid", quantity } }).needsChoice, true);
    }
    assert.equal(match({ walletOverride: { instrument: "prepaid", quantity: 1 } }).needsChoice, true);
  });

  it("수량 0 또는 명시적 생략은 일반 사후 문자를 선택한다", () => {
    const passes = [pass("auto")];
    assert.deepEqual(match({ passes, walletOverride: { instrument: "pass", passId: "missing", quantity: 0 } }), skipped);
    assert.deepEqual(match({ passes, walletOverride: { instrument: "prepaid", quantity: 0 } }), skipped);
    assert.deepEqual(match({ passes, walletOverride: { instrument: "skipped" } }), skipped);
  });

  it("차감안 비교는 순위·수단·횟수권을 확인하고 같은 수단의 수량은 별도로 비교한다", () => {
    const prepaid = match({ prepaidBalance: 40_000 });
    const card = match({ passes: [pass("first")] });
    assert.equal(sameInstrument(prepaid, match({ prepaidBalance: 10_000 })), true);
    assert.equal(sameInstrument(prepaid, { ...prepaid, quantity: 10_000 }), true);
    assert.equal(sameInstrument(prepaid, { ...prepaid, rank: 3 }), false);
    assert.equal(sameInstrument(prepaid, card), false);
    assert.equal(sameInstrument(card, match({ passes: [pass("second")] })), false);
    assert.equal(sameInstrument(match(), { ...match(), needsChoice: true }), false);
  });
});
