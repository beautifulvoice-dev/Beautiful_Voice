import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  type AppointmentState,
  type AppointmentStatus,
  type StatusAction,
  type TransitionContext,
  OCCUPIES_LANE,
  effectiveStatus,
  initialStatus,
  transition,
} from "../src/status.ts";

// 합성 데이터. 예약 10:00~11:00(KST), 기준 시각 세 개.
const t = (hhmm: string) => new Date(`2026-11-24T${hhmm}:00+09:00`);
const BEFORE = t("09:00");
const DURING = t("10:30");
const AFTER = t("12:00");
const appt = (status: AppointmentStatus): AppointmentState => ({ status, start: t("10:00"), end: t("11:00") });
const owner = (now: Date, source: TransitionContext["source"] = "web"): TransitionContext => ({ actor: "owner", source, now });
const system = (now: Date): TransitionContext => ({ actor: "system", source: "system", now });

describe("initialStatus — R-7 승인 = 확정", () => {
  it("원장이 만들면 확정, 충돌 검사 필요", () => {
    const r = initialStatus(owner(BEFORE));
    assert.ok(r.ok);
    assert.equal(r.to, "confirmed");
    assert.equal(r.needsConflictCheck, true);
    assert.deepEqual(r.event, { type: "created", from: null, to: "confirmed", actor: "owner", source: "web", at: BEFORE });
  });
  it("마이크·채팅 변경안을 원장이 승인해 만든 예약도 확정 — 출처만 다르다", () => {
    for (const source of ["voice", "chat"] as const) {
      const r = initialStatus(owner(BEFORE, source));
      assert.ok(r.ok);
      assert.equal(r.to, "confirmed");
      assert.equal(r.event.source, source);
    }
  });
  it("원장이 아닌 경로(전화 접수 등)는 요청, 자리를 차지하지 않는다", () => {
    const r = initialStatus({ actor: "external", source: "phone", now: BEFORE });
    assert.ok(r.ok);
    assert.equal(r.to, "requested");
    assert.equal(r.needsConflictCheck, false);
  });
  it("시스템은 예약을 만들 수 없다", () => {
    assert.deepEqual(initialStatus(system(BEFORE)), { ok: false, error: "ACTOR_NOT_ALLOWED" });
  });
});

describe("effectiveStatus — R-8·R-9 자동 완료", () => {
  it("확정 예약은 끝 시각부터 완료로 보인다", () => {
    assert.equal(effectiveStatus(appt("confirmed"), DURING), "confirmed");
    assert.equal(effectiveStatus(appt("confirmed"), t("11:00")), "completed");
  });
  it("요청 상태는 시간이 지나도 요청으로 남는다", () => {
    assert.equal(effectiveStatus(appt("requested"), AFTER), "requested");
  });
  it("취소·노쇼는 그대로", () => {
    assert.equal(effectiveStatus(appt("canceled"), AFTER), "canceled");
    assert.equal(effectiveStatus(appt("no_show"), AFTER), "no_show");
  });
});

// 원장이 각 시각에 각 동작을 했을 때의 결과 — 전이 표 전체.
// 값: 바뀐 상태 / 오류 코드. 저장값 기준 행, 시각은 BEFORE·DURING·AFTER.
type Outcome = AppointmentStatus | "INVALID_TRANSITION" | "TOO_EARLY";
const OWNER_TABLE: Record<AppointmentStatus, Record<Exclude<StatusAction, "complete">, [Outcome, Outcome, Outcome]>> = {
  requested: {
    approve: ["confirmed", "confirmed", "confirmed"],
    reject: ["canceled", "canceled", "canceled"],
    cancel: ["canceled", "canceled", "canceled"],
    mark_no_show: ["INVALID_TRANSITION", "INVALID_TRANSITION", "INVALID_TRANSITION"],
    undo_no_show: ["INVALID_TRANSITION", "INVALID_TRANSITION", "INVALID_TRANSITION"],
  },
  confirmed: {
    approve: ["INVALID_TRANSITION", "INVALID_TRANSITION", "INVALID_TRANSITION"],
    reject: ["INVALID_TRANSITION", "INVALID_TRANSITION", "INVALID_TRANSITION"],
    // 끝난 확정 예약은 완료로 보이므로 취소 불가
    cancel: ["canceled", "canceled", "INVALID_TRANSITION"],
    mark_no_show: ["TOO_EARLY", "no_show", "no_show"],
    undo_no_show: ["INVALID_TRANSITION", "INVALID_TRANSITION", "INVALID_TRANSITION"],
  },
  completed: {
    approve: ["INVALID_TRANSITION", "INVALID_TRANSITION", "INVALID_TRANSITION"],
    reject: ["INVALID_TRANSITION", "INVALID_TRANSITION", "INVALID_TRANSITION"],
    cancel: ["INVALID_TRANSITION", "INVALID_TRANSITION", "INVALID_TRANSITION"],
    mark_no_show: ["TOO_EARLY", "no_show", "no_show"],
    undo_no_show: ["INVALID_TRANSITION", "INVALID_TRANSITION", "INVALID_TRANSITION"],
  },
  canceled: {
    approve: ["INVALID_TRANSITION", "INVALID_TRANSITION", "INVALID_TRANSITION"],
    reject: ["INVALID_TRANSITION", "INVALID_TRANSITION", "INVALID_TRANSITION"],
    cancel: ["INVALID_TRANSITION", "INVALID_TRANSITION", "INVALID_TRANSITION"],
    mark_no_show: ["INVALID_TRANSITION", "INVALID_TRANSITION", "INVALID_TRANSITION"],
    undo_no_show: ["INVALID_TRANSITION", "INVALID_TRANSITION", "INVALID_TRANSITION"],
  },
  no_show: {
    approve: ["INVALID_TRANSITION", "INVALID_TRANSITION", "INVALID_TRANSITION"],
    reject: ["INVALID_TRANSITION", "INVALID_TRANSITION", "INVALID_TRANSITION"],
    cancel: ["INVALID_TRANSITION", "INVALID_TRANSITION", "INVALID_TRANSITION"],
    mark_no_show: ["INVALID_TRANSITION", "INVALID_TRANSITION", "INVALID_TRANSITION"],
    undo_no_show: ["confirmed", "confirmed", "completed"],
  },
};

describe("transition — 원장 동작 전이 표 (5 상태 × 5 동작 × 3 시각)", () => {
  const times = [BEFORE, DURING, AFTER] as const;
  const labels = ["시작 전", "진행 중", "끝난 뒤"] as const;
  for (const [status, actions] of Object.entries(OWNER_TABLE) as [AppointmentStatus, (typeof OWNER_TABLE)["requested"]][]) {
    for (const [action, outcomes] of Object.entries(actions) as [StatusAction, [Outcome, Outcome, Outcome]][]) {
      it(`${status} + ${action}`, () => {
        times.forEach((now, i) => {
          const r = transition(appt(status), action, owner(now));
          const got = r.ok ? r.to : r.error;
          assert.equal(got, outcomes[i], `${labels[i]}: ${status} + ${action}`);
        });
      });
    }
  }
});

describe("transition — 주체 제한", () => {
  it("원장 동작은 시스템·외부 경로가 할 수 없다", () => {
    for (const actor of ["system", "external"] as const) {
      const r = transition(appt("requested"), "approve", { actor, source: "system", now: DURING });
      assert.deepEqual(r, { ok: false, error: "ACTOR_NOT_ALLOWED" });
    }
  });
  it("complete는 시스템만, 끝 시각 이후에만", () => {
    assert.deepEqual(transition(appt("confirmed"), "complete", owner(AFTER)), { ok: false, error: "ACTOR_NOT_ALLOWED" });
    assert.deepEqual(transition(appt("confirmed"), "complete", system(DURING)), { ok: false, error: "TOO_EARLY" });
    const r = transition(appt("confirmed"), "complete", system(AFTER));
    assert.ok(r.ok);
    assert.equal(r.to, "completed");
    assert.equal(r.event.from, "confirmed");
  });
  it("이미 완료·요청·취소·노쇼인 예약은 complete 대상이 아니다", () => {
    for (const s of ["completed", "requested", "canceled", "no_show"] as const) {
      assert.deepEqual(transition(appt(s), "complete", system(AFTER)), { ok: false, error: "INVALID_TRANSITION" });
    }
  });
});

describe("transition — 자리 점유와 충돌 검사", () => {
  it("요청 승인은 자리를 새로 차지하므로 충돌 검사 필요", () => {
    const r = transition(appt("requested"), "approve", owner(BEFORE));
    assert.ok(r.ok && r.needsConflictCheck);
  });
  it("노쇼 되돌리기는 비웠던 자리를 다시 차지하므로 충돌 검사 필요", () => {
    const r = transition(appt("no_show"), "undo_no_show", owner(DURING));
    assert.ok(r.ok && r.needsConflictCheck);
  });
  it("취소·노쇼·완료는 충돌 검사 불필요", () => {
    for (const [s, a, now] of [
      ["confirmed", "cancel", BEFORE],
      ["confirmed", "mark_no_show", DURING],
    ] as const) {
      const r = transition(appt(s), a, owner(now));
      assert.ok(r.ok && !r.needsConflictCheck, `${s} + ${a}`);
    }
    const c = transition(appt("confirmed"), "complete", system(AFTER));
    assert.ok(c.ok && !c.needsConflictCheck);
  });
  it("자리 점유 상태는 DB 제약 WHERE와 같다 (확정·완료)", () => {
    assert.deepEqual([...OCCUPIES_LANE].sort(), ["completed", "confirmed"]);
  });
});

describe("transition — 이력 이벤트", () => {
  it("끝난 확정 예약을 노쇼로 바꾸면 from은 화면에 보이던 완료", () => {
    const r = transition(appt("confirmed"), "mark_no_show", { ...owner(AFTER, "chat"), reason: "연락 없이 안 오심" });
    assert.ok(r.ok);
    assert.deepEqual(r.event, {
      type: "mark_no_show",
      from: "completed",
      to: "no_show",
      actor: "owner",
      source: "chat",
      at: AFTER,
      reason: "연락 없이 안 오심",
    });
  });
  it("이유가 없으면 reason 필드를 넣지 않는다", () => {
    const r = transition(appt("confirmed"), "cancel", owner(BEFORE, "voice"));
    assert.ok(r.ok);
    assert.equal("reason" in r.event, false);
    assert.equal(r.event.source, "voice");
  });
});
