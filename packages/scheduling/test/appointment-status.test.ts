// BEA-178 완료·노쇼와 상태 고치기 (명세 3 기능 2A-3.3, 명세 1 §2.2 상태 전이표, 명세 2 §4.4).
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  APPOINTMENT_STATUSES,
  type AppointmentStatus,
  OCCUPYING,
  changeStatus,
} from "../src/appointment-status.ts";

const VISIBLE: AppointmentStatus[] = ["scheduled", "completed", "cancelled", "no_show"];

describe("예약 상태 5종", () => {
  it("예정·완료·취소·노쇼·무효", () => {
    assert.deepEqual([...APPOINTMENT_STATUSES], ["scheduled", "completed", "cancelled", "no_show", "voided"]);
  });

  it("점유하는 상태는 예정·완료·노쇼", () => {
    assert.deepEqual([...OCCUPYING].sort(), ["completed", "no_show", "scheduled"]);
  });
});

describe("원장의 상태 변경과 정정", () => {
  it("예정·완료·취소·노쇼 네 가지 사이는 어느 방향이든 바꿀 수 있다", () => {
    for (const from of VISIBLE) {
      for (const to of VISIBLE) {
        if (from === to) continue;
        const r = changeStatus(from, to, { undoOfTask: false });
        assert.equal(r.ok, true, `${from} → ${to}`);
      }
    }
  });

  it("같은 상태로 바꾸는 것은 변경이 아니다", () => {
    assert.deepEqual(changeStatus("completed", "completed", { undoOfTask: false }), { ok: false, error: "NO_CHANGE" });
  });

  it("취소를 되살리면(점유하지 않던 → 점유) 겹침 검사가 필요하다", () => {
    for (const to of ["scheduled", "completed", "no_show"] as const) {
      assert.deepEqual(changeStatus("cancelled", to, { undoOfTask: false }), { ok: true, to, needsOverlapCheck: true });
    }
    assert.deepEqual(changeStatus("scheduled", "completed", { undoOfTask: false }), { ok: true, to: "completed", needsOverlapCheck: false });
    assert.deepEqual(changeStatus("completed", "cancelled", { undoOfTask: false }), { ok: true, to: "cancelled", needsOverlapCheck: false });
  });
});

describe("무효(voided)", () => {
  it("예정 → 무효는 AI가 만든 예약의 되돌리기에서만", () => {
    assert.deepEqual(changeStatus("scheduled", "voided", { undoOfTask: true }), { ok: true, to: "voided", needsOverlapCheck: false });
    assert.deepEqual(changeStatus("scheduled", "voided", { undoOfTask: false }), { ok: false, error: "INVALID_TRANSITION" });
  });

  it("예정이 아닌 상태에서는 무효로 갈 수 없다", () => {
    for (const from of ["completed", "cancelled", "no_show"] as const) {
      assert.deepEqual(changeStatus(from, "voided", { undoOfTask: true }), { ok: false, error: "INVALID_TRANSITION" });
    }
  });

  it("무효에서 나가는 전이는 없다", () => {
    for (const to of VISIBLE) {
      assert.deepEqual(changeStatus("voided", to, { undoOfTask: true }), { ok: false, error: "INVALID_TRANSITION" });
      assert.deepEqual(changeStatus("voided", to, { undoOfTask: false }), { ok: false, error: "INVALID_TRANSITION" });
    }
  });
});
