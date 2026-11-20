// BEA-177 예약 저장 검사 (명세 3 기능 2A-3.4·2A-3.6·2A-3.7, 명세 1 §2.2, AC-CRM-2·AC-CRM-3·AC-S2-1).
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  type ActiveBlock,
  type ExistingBooking,
  type ShopHours,
  blockedAppointmentIds,
  checkBooking,
  occupiedOf,
} from "../src/booking.ts";

/** 2026-12-01(화) 서울 시각. */
const at = (hhmm: string, date = "2026-12-01") => new Date(`${date}T${hhmm}:00+09:00`);
const req = (staffId: string, hhmm: string, durationMin = 60, prepMin = 0, date?: string) =>
  ({ staffId, start: at(hhmm, date), durationMin, prepMin });
const booked = (id: string, staffId: string, hhmm: string, durationMin = 60, prepMin = 0, status = "scheduled"): ExistingBooking =>
  ({ id, staffId, status, occupied: occupiedOf(req(staffId, hhmm, durationMin, prepMin)) } as ExistingBooking);
const OPEN: ShopHours = { businessHours: null, closures: [] };
const reasonOf = (r: ReturnType<typeof checkBooking>) => (r.ok ? "ok" : r.reason);

describe("점유 구간 = [시작 − 준비, 시작 + 관리)", () => {
  it("AC-CRM-2: 14:00 시작·관리 60분·준비 20분이면 13:40~15:00", () => {
    assert.deepEqual(occupiedOf(req("A", "14:00", 60, 20)), { start: at("13:40"), end: at("15:00") });
  });
});

describe("같은 담당자 겹침", () => {
  const existing = [booked("x", "A", "14:00", 60, 20)];

  it("AC-CRM-2: 같은 담당자 겹침은 거부하고 겹친 예약을 알려 준다", () => {
    const r = checkBooking(req("A", "14:30"), OPEN, existing, []);
    assert.deepEqual(r, { ok: false, reason: "STAFF_OVERLAP", conflictingIds: ["x"] });
  });

  it("AC-CRM-2: 다른 담당자는 같은 시각에 받을 수 있다", () => {
    assert.equal(reasonOf(checkBooking(req("B", "14:00", 60, 20), OPEN, existing, [])), "ok");
  });

  it("새 예약의 준비 시간도 점유다 — 15:10 시작·준비 20분은 앞 예약(~15:00)과 겹친다", () => {
    assert.equal(reasonOf(checkBooking(req("A", "15:10", 60, 20), OPEN, existing, [])), "STAFF_OVERLAP");
    assert.equal(reasonOf(checkBooking(req("A", "15:20", 60, 20), OPEN, existing, [])), "ok");
  });

  it("반열림 구간 — 끝과 시작이 맞닿으면 겹치지 않는다", () => {
    assert.equal(reasonOf(checkBooking(req("A", "15:00"), OPEN, existing, [])), "ok");
    assert.equal(reasonOf(checkBooking(req("A", "12:40", 60), OPEN, existing, [])), "ok");
  });

  it("완료·노쇼는 점유를 유지하고, 취소·무효는 빠진다", () => {
    for (const status of ["completed", "no_show"]) {
      assert.equal(reasonOf(checkBooking(req("A", "14:00"), OPEN, [booked("x", "A", "14:00", 60, 0, status)], [])), "STAFF_OVERLAP");
    }
    for (const status of ["cancelled", "voided"]) {
      assert.equal(reasonOf(checkBooking(req("A", "14:00"), OPEN, [booked("x", "A", "14:00", 60, 0, status)], [])), "ok");
    }
  });

  it("시간을 옮길 때는 자기 자신을 빼고 검사한다", () => {
    assert.equal(reasonOf(checkBooking(req("A", "14:30"), OPEN, existing, [], { excludeId: "x" })), "ok");
  });
});

describe("영업시간·휴무 (AC-S2-1)", () => {
  const hours: ShopHours = {
    // 화요일(2) 10:00~19:00
    businessHours: { 2: [{ open: "10:00", close: "19:00" }] },
    closures: [],
  };

  it("관리 시간이 영업시간 안이면 허용, 밖이면 OUTSIDE_BUSINESS_HOURS", () => {
    assert.equal(reasonOf(checkBooking(req("A", "18:00"), hours, [], [])), "ok");
    assert.equal(reasonOf(checkBooking(req("A", "18:30"), hours, [], [])), "OUTSIDE_BUSINESS_HOURS");
    assert.equal(reasonOf(checkBooking(req("A", "09:30"), hours, [], [])), "OUTSIDE_BUSINESS_HOURS");
  });

  it("준비 시간은 영업 시작 전에 걸쳐도 된다", () => {
    assert.equal(reasonOf(checkBooking(req("A", "10:00", 60, 30), hours, [], [])), "ok");
  });

  it("영업시간이 없는 요일은 휴무", () => {
    assert.equal(reasonOf(checkBooking(req("A", "12:00", 60, 0, "2026-12-02"), hours, [], [])), "CLOSED_DAY");
  });

  it("영업시간을 넣지 않은 매장은 영업시간 검사를 하지 않고 휴무만 검사한다", () => {
    const noHours: ShopHours = { businessHours: null, closures: [{ kind: "weekly", weekday: 2 }] };
    assert.equal(reasonOf(checkBooking(req("A", "03:00", 60, 0, "2026-12-02"), noHours, [], [])), "ok");
    assert.equal(reasonOf(checkBooking(req("A", "12:00"), noHours, [], [])), "CLOSED_DAY");
  });

  it("휴무: 매주 요일(1=월 … 7=일)과 날짜 구간(시작·끝 포함)", () => {
    const sunday: ShopHours = { businessHours: null, closures: [{ kind: "weekly", weekday: 7 }] };
    assert.equal(reasonOf(checkBooking(req("A", "12:00", 60, 0, "2026-12-06"), sunday, [], [])), "CLOSED_DAY");
    const vacation: ShopHours = { businessHours: null, closures: [{ kind: "vacation", startDate: "2026-11-30", endDate: "2026-12-01" }] };
    assert.equal(reasonOf(checkBooking(req("A", "12:00", 60, 0, "2026-11-30"), vacation, [], [])), "CLOSED_DAY");
    assert.equal(reasonOf(checkBooking(req("A", "12:00"), vacation, [], [])), "CLOSED_DAY");
    assert.equal(reasonOf(checkBooking(req("A", "12:00", 60, 0, "2026-12-02"), vacation, [], [])), "ok");
  });

  it("되돌리기 복원은 영업시간·휴무 검사를 건너뛸 수 있다(겹침·차단은 그대로 검사)", () => {
    const closed: ShopHours = { businessHours: null, closures: [{ kind: "weekly", weekday: 2 }] };
    assert.equal(reasonOf(checkBooking(req("A", "12:00"), closed, [], [], { skipHoursCheck: true })), "ok");
    assert.equal(
      reasonOf(checkBooking(req("A", "12:00"), closed, [booked("x", "A", "12:00")], [], { skipHoursCheck: true })),
      "STAFF_OVERLAP",
    );
  });

  it("영업시간을 넣지 않은 매장에서도 자정을 넘어 다음 날 휴무에 걸치면 거부(#36 리뷰)", () => {
    // 12/02(수) 휴무. 12/01 23:30 시작 60분은 12/02 00:30까지 간다.
    const wednesdayOff: ShopHours = { businessHours: null, closures: [{ kind: "weekly", weekday: 3 }] };
    assert.equal(reasonOf(checkBooking(req("A", "23:30"), wednesdayOff, [], [])), "CLOSED_DAY");
    assert.equal(reasonOf(checkBooking(req("A", "23:00"), wednesdayOff, [], [])), "ok");
  });

  it("여러 날에 걸친 관리는 사이에 낀 휴무일도 검사(#36 리뷰 2회)", () => {
    // 12/04(금) 23:00 시작 1530분 = 12/06(일) 00:30까지. 사이의 12/05(토)가 휴무면 거부.
    const fridayLate = req("A", "23:00", 1530, 0, "2026-12-04");
    const saturdayOff: ShopHours = { businessHours: null, closures: [{ kind: "weekly", weekday: 6 }] };
    assert.equal(reasonOf(checkBooking(fridayLate, saturdayOff, [], [])), "CLOSED_DAY");
    const saturdayVacation: ShopHours = { businessHours: null, closures: [{ kind: "vacation", startDate: "2026-12-05", endDate: "2026-12-05" }] };
    assert.equal(reasonOf(checkBooking(fridayLate, saturdayVacation, [], [])), "CLOSED_DAY");
    // 걸치는 날(금·토·일) 밖의 휴무는 통과
    const mondayOff: ShopHours = { businessHours: null, closures: [{ kind: "weekly", weekday: 1 }] };
    assert.equal(reasonOf(checkBooking(fridayLate, mondayOff, [], [])), "ok");
    // 7일 이상 걸치면 매주 휴무 어느 요일이든 걸린다
    const week = req("A", "10:00", 7 * 24 * 60, 0, "2026-12-01");
    assert.equal(reasonOf(checkBooking(week, mondayOff, [], [])), "CLOSED_DAY");
  });

  it("자정을 넘는 관리는 영업시간 밖", () => {
    const allDay: ShopHours = { businessHours: { 2: [{ open: "00:00", close: "24:00" }] }, closures: [] };
    assert.equal(reasonOf(checkBooking(req("A", "23:30"), allDay, [], [])), "OUTSIDE_BUSINESS_HOURS");
    assert.equal(reasonOf(checkBooking(req("A", "23:00"), allDay, [], [])), "ok");
  });
});

describe("캘린더 차단 (AC-CRM-3)", () => {
  const blockA: ActiveBlock = { id: "b1", start: at("12:00"), end: at("13:00"), allStaff: false, staffIds: ["A"] };
  const blockAll: ActiveBlock = { id: "b2", start: at("16:00"), end: at("17:00"), allStaff: true, staffIds: [] };

  it("담당자 A만 막은 차단은 A의 새 예약만 막는다", () => {
    assert.deepEqual(checkBooking(req("A", "12:30"), OPEN, [], [blockA]), { ok: false, reason: "BLOCKED", conflictingIds: ["b1"] });
    assert.equal(reasonOf(checkBooking(req("B", "12:30"), OPEN, [], [blockA])), "ok");
  });

  it("매장 전체 차단은 모든 담당자를 막는다", () => {
    assert.equal(reasonOf(checkBooking(req("A", "16:30"), OPEN, [], [blockAll])), "BLOCKED");
    assert.equal(reasonOf(checkBooking(req("Z", "16:30"), OPEN, [], [blockAll])), "BLOCKED");
  });

  it("차단 비교 구간은 점유 구간(준비 시간 포함)", () => {
    assert.equal(reasonOf(checkBooking(req("A", "13:10", 60, 20), OPEN, [], [blockA])), "BLOCKED");
    assert.equal(reasonOf(checkBooking(req("A", "13:20", 60, 20), OPEN, [], [blockA])), "ok");
  });

  it("차단을 새로 만들어도 기존 예약은 막지 않고, 충돌하는 예약 id만 알려 준다", () => {
    const appointments = [
      booked("a1", "A", "12:30"),
      booked("b1", "B", "12:30"),
      booked("a2", "A", "12:30", 60, 0, "cancelled"),
      booked("a3", "A", "13:00"),
    ];
    assert.deepEqual(blockedAppointmentIds(blockA, appointments), ["a1"]);
    assert.deepEqual(blockedAppointmentIds({ ...blockA, allStaff: true, staffIds: [] }, appointments), ["a1", "b1"]);
  });
});

describe("입력 검사", () => {
  it("관리 시간은 1분 이상 정수, 준비 시간은 0분 이상 정수, 시각은 유효해야 한다", () => {
    for (const bad of [req("A", "12:00", 0), req("A", "12:00", 1.5), req("A", "12:00", 60, -1), req("A", "12:00", 60, 0.5)]) {
      assert.equal(reasonOf(checkBooking(bad, OPEN, [], [])), "INVALID_PERIOD");
    }
    assert.equal(reasonOf(checkBooking({ staffId: "A", start: new Date("x"), durationMin: 60, prepMin: 0 }, OPEN, [], [])), "INVALID_PERIOD");
    assert.equal(reasonOf(checkBooking({ staffId: "", start: at("12:00"), durationMin: 60, prepMin: 0 }, OPEN, [], [])), "STAFF_REQUIRED");
  });

  it("검사 순서: 입력 → 영업시간·휴무 → 차단 → 겹침", () => {
    const closed: ShopHours = { businessHours: null, closures: [{ kind: "weekly", weekday: 2 }] };
    const block: ActiveBlock = { id: "b", start: at("12:00"), end: at("13:00"), allStaff: true, staffIds: [] };
    assert.equal(reasonOf(checkBooking(req("A", "12:00"), closed, [booked("x", "A", "12:00")], [block])), "CLOSED_DAY");
    assert.equal(reasonOf(checkBooking(req("A", "12:00"), OPEN, [booked("x", "A", "12:00")], [block])), "BLOCKED");
  });
});
