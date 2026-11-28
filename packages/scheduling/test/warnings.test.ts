// S3 캘린더 rev.3.1 경고 판정(명세 §4.2). 거부 대신 경고 목록 — 저장 여부는 호출한 쪽이 정한다.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ActiveBlock, ShopHours } from "../src/booking.ts";
import { type OccupyingAppointment, appointmentWarnings, occupancyOf } from "../src/warnings.ts";

/** 2026-12-01(화) 서울 시각. */
const at = (hhmm: string, date = "2026-12-01") => new Date(`${date}T${hhmm}:00+09:00`);
const slot = (staffId: string | null, hhmm: string, durationMin = 60, cleanupMin = 0, date?: string) =>
  ({ staffId, start: at(hhmm, date), durationMin, cleanupMin });
const booked = (id: string, staffId: string | null, hhmm: string, durationMin = 60, cleanupMin = 0, status = "scheduled") =>
  ({ id, staffId, status, occupied: occupancyOf(slot(staffId, hhmm, durationMin, cleanupMin)) }) as OccupyingAppointment;
const block = (id: string, from: string, to: string, staffIds: string[] = []): ActiveBlock =>
  ({ id, start: at(from), end: at(to), allStaff: staffIds.length === 0, staffIds });
const OPEN: ShopHours = { businessHours: null, closures: [] };
const codes = (w: ReturnType<typeof appointmentWarnings>) => w.map((x) => x.code);

describe("점유 구간 = [시작, 시작 + 시술 + 정리)", () => {
  it("14:00 시작·시술 60분·정리 20분이면 14:00~15:20", () => {
    assert.deepEqual(occupancyOf(slot("A", "14:00", 60, 20)), { start: at("14:00"), end: at("15:20") });
  });
});

describe("예약 겹침 경고", () => {
  it("같은 담당자 겹침은 경고하고, 다른 지정 담당자끼리 같은 시각은 경고 없음", () => {
    const existing = [booked("x", "A", "14:00")];
    assert.deepEqual(appointmentWarnings(slot("A", "14:30"), OPEN, existing, []), [{ code: "OVERLAP_APPOINTMENT", relatedIds: ["x"] }]);
    assert.deepEqual(appointmentWarnings(slot("B", "14:00"), OPEN, existing, []), []);
  });

  it("담당자 미지정은 한쪽이든 양쪽이든 누구와도 겹친다", () => {
    assert.deepEqual(codes(appointmentWarnings(slot(null, "14:30"), OPEN, [booked("x", "A", "14:00")], [])), ["OVERLAP_APPOINTMENT"]);
    assert.deepEqual(codes(appointmentWarnings(slot("B", "14:30"), OPEN, [booked("x", null, "14:00")], [])), ["OVERLAP_APPOINTMENT"]);
    assert.deepEqual(codes(appointmentWarnings(slot(null, "14:30"), OPEN, [booked("x", null, "14:00")], [])), ["OVERLAP_APPOINTMENT"]);
  });

  it("정리 시간만 겹쳐도 경고, 끝과 시작이 같으면 경고 없음(반열린 구간)", () => {
    const existing = [booked("x", "A", "14:00", 60, 20)]; // 14:00~15:20
    assert.deepEqual(codes(appointmentWarnings(slot("A", "15:10"), OPEN, existing, [])), ["OVERLAP_APPOINTMENT"]);
    assert.deepEqual(appointmentWarnings(slot("A", "15:20"), OPEN, existing, []), []);
    // 새 예약의 정리 시간이 다음 예약 시작에 걸리는 경우, 맞닿기만 하는 경우.
    assert.deepEqual(codes(appointmentWarnings(slot("A", "12:50", 60, 20), OPEN, existing, [])), ["OVERLAP_APPOINTMENT"]);
    assert.deepEqual(appointmentWarnings(slot("A", "12:40", 60, 20), OPEN, existing, []), []);
  });

  it("고치는 예약 자신은 빼고, 취소·무효는 점유하지 않는다", () => {
    assert.deepEqual(appointmentWarnings(slot("A", "14:30"), OPEN, [booked("x", "A", "14:00")], [], { excludeId: "x" }), []);
    for (const status of ["cancelled", "voided"]) {
      assert.deepEqual(appointmentWarnings(slot("A", "14:00"), OPEN, [booked("x", "A", "14:00", 60, 0, status)], []), []);
    }
    for (const status of ["completed", "no_show"]) {
      assert.equal(appointmentWarnings(slot("A", "14:00"), OPEN, [booked("x", "A", "14:00", 60, 0, status)], []).length, 1);
    }
  });

  it("겹친 예약 id를 모두 넘겨받은 순서대로", () => {
    const existing = [booked("x", "A", "14:00"), booked("y", null, "14:30"), booked("z", "B", "14:00")];
    assert.deepEqual(appointmentWarnings(slot("A", "14:15"), OPEN, existing, []), [{ code: "OVERLAP_APPOINTMENT", relatedIds: ["x", "y"] }]);
  });
});

describe("차단 겹침 경고", () => {
  const blockA = block("b1", "12:00", "13:00", ["A"]);
  const blockAll = block("b2", "16:00", "17:00");

  it("담당자 차단은 그 담당자만, 매장 전체 차단은 모두", () => {
    assert.deepEqual(appointmentWarnings(slot("A", "12:30"), OPEN, [], [blockA]), [{ code: "OVERLAP_BLOCK", relatedIds: ["b1"] }]);
    assert.deepEqual(appointmentWarnings(slot("B", "12:30"), OPEN, [], [blockA]), []);
    assert.deepEqual(codes(appointmentWarnings(slot("B", "16:30"), OPEN, [], [blockAll])), ["OVERLAP_BLOCK"]);
  });

  it("미지정 예약은 시간대가 겹치는 모든 활성 차단이 대상", () => {
    assert.deepEqual(appointmentWarnings(slot(null, "12:30", 240), OPEN, [], [blockA, blockAll]), [
      { code: "OVERLAP_BLOCK", relatedIds: ["b1", "b2"] },
    ]);
  });

  it("정리 시간만 차단에 걸려도 경고, 맞닿기만 하면 없음", () => {
    assert.deepEqual(codes(appointmentWarnings(slot("A", "11:00", 50, 20), OPEN, [], [blockA])), ["OVERLAP_BLOCK"]);
    assert.deepEqual(appointmentWarnings(slot("A", "11:00", 40, 20), OPEN, [], [blockA]), []);
  });

  it("자정을 넘는 차단", () => {
    const overnight: ActiveBlock = { id: "n", start: at("23:00"), end: at("02:00", "2026-12-02"), allStaff: true, staffIds: [] };
    assert.deepEqual(codes(appointmentWarnings(slot("A", "01:00", 60, 0, "2026-12-02"), OPEN, [], [overnight])), ["OVERLAP_BLOCK"]);
    assert.deepEqual(appointmentWarnings(slot("A", "02:00", 60, 0, "2026-12-02"), OPEN, [], [overnight]), []);
  });
});

describe("영업시간·휴무 경고(시술 구간 기준)", () => {
  const hours: ShopHours = { businessHours: { 2: [{ open: "10:00", close: "19:00" }] }, closures: [] };

  it("영업시간 밖은 OUTSIDE_BUSINESS_HOURS, 정리 시간은 마감 뒤로 넘어가도 된다", () => {
    assert.deepEqual(appointmentWarnings(slot("A", "18:30"), hours, [], []), [{ code: "OUTSIDE_BUSINESS_HOURS", relatedIds: [] }]);
    assert.deepEqual(appointmentWarnings(slot("A", "18:00", 60, 30), hours, [], []), []);
  });

  it("휴무는 CLOSED_DAY, skipHoursCheck면 보지 않는다", () => {
    const closed: ShopHours = { businessHours: null, closures: [{ kind: "weekly", weekday: 2 }] };
    assert.deepEqual(codes(appointmentWarnings(slot("A", "12:00"), closed, [], [])), ["CLOSED_DAY"]);
    assert.deepEqual(appointmentWarnings(slot("A", "12:00"), closed, [], [], { skipHoursCheck: true }), []);
  });

  it("여러 경고가 함께 해당하면 예약 → 차단 → 영업시간 순서로 모두 돌려준다", () => {
    const closed: ShopHours = { businessHours: null, closures: [{ kind: "weekly", weekday: 2 }] };
    assert.deepEqual(
      appointmentWarnings(slot(null, "12:30"), closed, [booked("x", "A", "12:00")], [block("b1", "12:00", "13:00", ["B"])]),
      [
        { code: "OVERLAP_APPOINTMENT", relatedIds: ["x"] },
        { code: "OVERLAP_BLOCK", relatedIds: ["b1"] },
        { code: "CLOSED_DAY", relatedIds: [] },
      ],
    );
  });
});

describe("입력 범위(시술 5~600, 정리 0~180)", () => {
  it("범위 경계는 판정하고, 밖은 RangeError — 입력 검사를 먼저 해야 한다", () => {
    assert.deepEqual(appointmentWarnings(slot("A", "10:00", 5, 0), OPEN, [], []), []);
    assert.deepEqual(appointmentWarnings(slot("A", "10:00", 600, 180), OPEN, [], []), []);
    for (const bad of [slot("A", "10:00", 4), slot("A", "10:00", 601), slot("A", "10:00", 60, 181), slot("A", "10:00", 60, -1),
      slot("A", "10:00", 60.5), slot("", "10:00"), { staffId: "A", start: new Date("x"), durationMin: 60, cleanupMin: 0 }]) {
      assert.throws(() => appointmentWarnings(bad, OPEN, [], []), RangeError);
    }
  });
});
