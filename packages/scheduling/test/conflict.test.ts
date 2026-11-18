import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  type BookedAppointment,
  type Decision,
  type ShopSchedule,
  checkShopRules,
  decideSave,
  localTimeToInstant,
  overlaps,
} from "../src/conflict.ts";

// 합성 데이터만 사용. 2026-11-24는 화요일, 매장 시간대 Asia/Seoul(UTC+9).
const kst = (hhmm: string, date = "2026-11-24") => new Date(`${date}T${hhmm}:00+09:00`);
const appt = (id: string, from: string, to: string, lane = 1): BookedAppointment => ({
  id,
  lane,
  start: kst(from),
  end: kst(to),
});
const req = (from: string, to: string, force = false, date = "2026-11-24") => ({
  start: kst(from, date),
  end: kst(to, date),
  force,
});

const OPEN = [{ open: "09:00", close: "21:00" }];
const schedule: ShopSchedule = {
  timeZone: "Asia/Seoul",
  weeklyHours: { 1: OPEN, 2: OPEN, 3: OPEN, 4: OPEN, 5: OPEN, 6: OPEN }, // 일요일 휴무
  closedDates: ["2026-11-25"],
  blocks: [{ start: kst("15:00"), end: kst("16:00") }],
};

function expectOk(d: Decision) {
  assert.equal(d.ok, true, `거절됨: ${d.ok ? "" : d.reason}`);
  if (!d.ok) throw new Error("unreachable");
  return d;
}
function expectReject(d: Decision, reason: string) {
  assert.equal(d.ok, false, "허용되면 안 됨");
  if (d.ok) throw new Error("unreachable");
  assert.equal(d.reason, reason);
  return d;
}

describe("overlaps — 반열림 구간 [start, end)", () => {
  it("끝과 시작이 맞닿으면 겹치지 않는다", () => {
    assert.equal(overlaps(appt("a", "10:00", "11:00"), appt("b", "11:00", "12:00")), false);
  });
  it("일부만 겹쳐도 겹친다", () => {
    assert.equal(overlaps(appt("a", "10:00", "11:00"), appt("b", "10:59", "12:00")), true);
  });
});

describe("decideSave — 02 §3 S4 반례", () => {
  it("겹치는 예약이 없으면 자리 1, 강제 아님", () => {
    const d = expectOk(decideSave(req("10:00", "11:00"), schedule, [appt("a", "11:00", "12:00")]));
    assert.equal(d.lane, 1);
    assert.equal(d.isForced, false);
    assert.equal(d.reassign.size, 0);
  });

  it("① B만 남은 상태에서 겹치는 C 일반 저장 → 409 (빈 자리가 있어도 거절)", () => {
    const d = expectReject(
      decideSave(req("10:45", "11:15"), schedule, [appt("B", "10:30", "11:30", 2)]),
      "APPOINTMENT_CONFLICT",
    );
    assert.deepEqual(d.conflictingIds, ["B"]);
  });

  it("② A·B 상태에서 B와만 겹치는 C 강제 저장 → 허용", () => {
    const d = expectOk(
      decideSave(req("11:00", "12:00", true), schedule, [
        appt("A", "10:00", "11:00", 1),
        appt("B", "10:30", "11:30", 2),
      ]),
    );
    assert.equal(d.isForced, true);
    assert.equal(d.lane, 1);
    assert.equal(d.reassign.size, 0);
  });

  it("③ A(자리1)·B(자리2) 사이를 잇는 C 강제 저장 → B를 자리1로 옮기고 허용", () => {
    const d = expectOk(
      decideSave(req("10:00", "13:00", true), schedule, [
        appt("A", "09:00", "11:00", 1),
        appt("B", "12:00", "14:00", 2),
      ]),
    );
    assert.equal(d.lane, 2);
    assert.deepEqual([...d.reassign], [["B", 1]]);
  });

  it("④ 같은 시간 3건째 강제 저장 → 동시 최대 2건 초과로 거절", () => {
    expectReject(
      decideSave(req("10:00", "11:00", true), schedule, [
        appt("A", "10:00", "11:00", 1),
        appt("B", "10:00", "11:00", 2),
      ]),
      "CAPACITY_EXCEEDED",
    );
  });

  it("④-2 3건이 한 순간에만 겹쳐도 거절", () => {
    expectReject(
      decideSave(req("10:50", "11:10", true), schedule, [
        appt("A", "10:00", "11:00", 1),
        appt("B", "10:30", "11:30", 2),
      ]),
      "CAPACITY_EXCEEDED",
    );
  });

  it("⑤ 영업시간 밖은 강제 저장도 거절", () => {
    expectReject(decideSave(req("20:30", "21:30", true), schedule, []), "OUTSIDE_BUSINESS_HOURS");
    expectReject(decideSave(req("08:30", "09:30", true), schedule, []), "OUTSIDE_BUSINESS_HOURS");
  });

  it("⑤ 임시 차단과 겹치면 강제 저장도 거절", () => {
    expectReject(decideSave(req("14:30", "15:30", true), schedule, []), "BLOCKED");
  });

  it("⑤ 휴무 요일·휴무일은 강제 저장도 거절", () => {
    expectReject(decideSave(req("10:00", "11:00", true, "2026-11-29"), schedule, []), "CLOSED_DAY"); // 일요일
    expectReject(decideSave(req("10:00", "11:00", true, "2026-11-25"), schedule, []), "CLOSED_DAY"); // 지정 휴무일
  });
});

describe("checkShopRules — 경계", () => {
  it("영업 시작·마감 시각에 딱 맞으면 허용", () => {
    const noBlocks = { ...schedule, blocks: [] };
    assert.equal(checkShopRules(req("09:00", "21:00"), noBlocks), null);
  });
  it("시작이 끝보다 같거나 늦으면 거절", () => {
    assert.equal(checkShopRules(req("10:00", "10:00"), schedule), "INVALID_PERIOD");
  });
  it("자정을 넘는 예약은 영업시간 밖", () => {
    const late = { start: kst("20:00"), end: kst("01:00", "2026-11-25") };
    assert.equal(checkShopRules(late, { ...schedule, closedDates: [] }), "OUTSIDE_BUSINESS_HOURS");
  });
  it("UTC 날짜와 매장 날짜가 다른 새벽 시각도 매장 날짜로 판정", () => {
    // KST 09:30 = UTC 전날 00:30. 매장 날짜(화)로 영업일 판정해야 한다.
    assert.equal(checkShopRules(req("09:30", "10:30"), schedule), null);
  });
});

describe("checkShopRules — UTC 오프셋 전환일 (PR #19 리뷰 회귀)", () => {
  // 합성 매장. 뉴욕은 2026-03-08(일) 02:00 → 03:00(봄), 2026-11-01(일) 02:00 → 01:00(가을) 전환.
  const ny = (open: string, close: string): ShopSchedule => ({
    timeZone: "America/New_York",
    weeklyHours: { 0: [{ open, close }] },
    closedDates: [],
    blocks: [],
  });
  const at = (iso: string) => new Date(iso);

  it("봄 전환일: 영업 01:00~03:30에 현지 01:30~04:00 예약은 영업시간 밖", () => {
    // 01:30 EST = 06:30Z, 04:00 EDT = 08:00Z. 마감 03:30 EDT = 07:30Z.
    const r = { start: at("2026-03-08T06:30:00Z"), end: at("2026-03-08T08:00:00Z") };
    assert.equal(checkShopRules(r, ny("01:00", "03:30")), "OUTSIDE_BUSINESS_HOURS");
  });

  it("봄 전환일: 마감 시각에 딱 끝나면 허용", () => {
    // 01:30 EST = 06:30Z ~ 03:30 EDT = 07:30Z (실제 1시간)
    const r = { start: at("2026-03-08T06:30:00Z"), end: at("2026-03-08T07:30:00Z") };
    assert.equal(checkShopRules(r, ny("01:00", "03:30")), null);
  });

  it("가을 전환일: 영업 00:00~03:00에 현지 00:30~02:30(실제 3시간)은 허용", () => {
    // 00:30 EDT = 04:30Z, 02:30 EST = 07:30Z. 마감 03:00 EST = 08:00Z.
    const r = { start: at("2026-11-01T04:30:00Z"), end: at("2026-11-01T07:30:00Z") };
    assert.equal(checkShopRules(r, ny("00:00", "03:00")), null);
  });

  it("봄 전환일: 존재하지 않는 개점 02:30은 03:30 EDT로 밀린다 — 01:35~01:50 예약 거절 (리뷰 2차 재현)", () => {
    // 01:35 EST = 06:35Z, 01:50 EST = 06:50Z. 개점 02:30(존재 안 함) → 03:30 EDT = 07:30Z.
    const r = { start: at("2026-03-08T06:35:00Z"), end: at("2026-03-08T06:50:00Z") };
    assert.equal(checkShopRules(r, ny("02:30", "04:00")), "OUTSIDE_BUSINESS_HOURS");
  });

  it("봄 전환일: 밀린 개점(03:30 EDT)부터는 허용", () => {
    // 03:30 EDT = 07:30Z ~ 04:00 EDT = 08:00Z
    const r = { start: at("2026-03-08T07:30:00Z"), end: at("2026-03-08T08:00:00Z") };
    assert.equal(checkShopRules(r, ny("02:30", "04:00")), null);
  });

  it("가을 전환일: 두 번 있는 01:30 개점은 먼저 오는 쪽(EDT)", () => {
    // 01:30 EDT = 05:30Z. 01:40 EDT(05:40Z)~02:00 EST(07:00Z) 허용, 01:00 EDT(05:00Z) 시작은 거절.
    assert.equal(checkShopRules({ start: at("2026-11-01T05:40:00Z"), end: at("2026-11-01T07:00:00Z") }, ny("01:30", "03:00")), null);
    assert.equal(
      checkShopRules({ start: at("2026-11-01T05:00:00Z"), end: at("2026-11-01T05:20:00Z") }, ny("01:30", "03:00")),
      "OUTSIDE_BUSINESS_HOURS",
    );
  });

  it("가을 전환일: 마감을 넘으면 거절", () => {
    // 00:30 EDT = 04:30Z ~ 03:30 EST = 08:30Z
    const r = { start: at("2026-11-01T04:30:00Z"), end: at("2026-11-01T08:30:00Z") };
    assert.equal(checkShopRules(r, ny("00:00", "03:00")), "OUTSIDE_BUSINESS_HOURS");
  });
});

describe("localTimeToInstant — 전환일 전수 검사", () => {
  // 전환이 있는 시간대들의 전환일 하루를 15분 간격으로 전부 확인한다.
  const cases: [string, string][] = [
    ["America/New_York", "2026-03-08"],
    ["America/New_York", "2026-11-01"],
    ["Europe/London", "2026-03-29"],
    ["Europe/London", "2026-10-25"],
    ["Australia/Sydney", "2026-04-05"],
    ["Australia/Sydney", "2026-10-04"],
    ["Asia/Seoul", "2026-11-24"],
  ];
  const wall = (instant: number, timeZone: string) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })
      .format(instant)
      .replace(",", "");

  for (const [tz, date] of cases) {
    it(`${tz} ${date}: 있는 시각은 그대로·순서 유지, 없는 시각은 건너뛴 1시간만큼 뒤로`, () => {
      const hhmmOf = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
      let prevExisting = -Infinity;
      for (let m = 0; m < 24 * 60; m += 15) {
        const hhmm = hhmmOf(m);
        const instant = localTimeToInstant(date, hhmm, tz);
        const back = wall(instant, tz);
        if (back === `${date} ${hhmm}`) {
          assert.ok(instant > prevExisting, `${tz} ${date} ${hhmm}: 있는 시각끼리 순서가 뒤집힘`);
          prevExisting = instant;
        } else {
          // 존재하지 않는 시각(봄 전환): 건너뛴 길이(이 시간대들은 1시간)만큼 뒤 — 앞당겨지면 안 된다.
          assert.equal(back, `${date} ${hhmmOf(m + 60)}`, `${tz} ${date} ${hhmm}`);
        }
      }
    });
  }
});

describe("자리 배정 성질 — 무작위 검증", () => {
  it("허용된 결과는 언제나 자리별로 겹치지 않고 자리는 1·2뿐", () => {
    let seed = 7;
    const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
    for (let round = 0; round < 300; round++) {
      let booked: BookedAppointment[] = [];
      for (let k = 0; k < 8; k++) {
        const startMin = 9 * 60 + rand(10) * 60 + rand(4) * 15;
        const len = 30 + rand(4) * 30;
        const toHHMM = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
        if (startMin + len > 21 * 60) continue;
        const r = req(toHHMM(startMin), toHHMM(startMin + len), rand(2) === 1);
        const d = decideSave(r, { ...schedule, blocks: [] }, booked);
        if (!d.ok) continue;
        booked = booked.map((a) => ({ ...a, lane: d.reassign.get(a.id) ?? a.lane }));
        booked.push({ id: `r${round}-${k}`, lane: d.lane, start: r.start, end: r.end });
      }
      for (const a of booked) {
        assert.ok(a.lane === 1 || a.lane === 2);
        for (const b of booked) {
          if (a !== b && a.lane === b.lane) assert.equal(overlaps(a, b), false, "같은 자리에서 겹침");
        }
      }
    }
  });
});
