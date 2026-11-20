// BEA-166(매장 정보와 휴무)·BEA-167(메뉴와 담당자)의 입력 검사 — 명세 3 기능 2A-1.1~2A-1.4, 명세 2 §2.3.
// 영업시간 형식은 booking.ts(BEA-177)가 읽는 BusinessHours와 같다. 합성 데이터만 쓴다.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MAX_MINUTES, validateBusinessHours, validateClosure, validateMenu, validateStaff } from "../src/shop-settings.ts";

describe("영업시간", () => {
  it("요일(1=월 … 7=일)별 구간을 시작 순으로 정리해 돌려준다", () => {
    assert.deepEqual(
      validateBusinessHours({ 2: [{ open: "14:00", close: "19:00" }, { open: "10:00", close: "13:00" }], 6: [{ open: "10:00", close: "24:00" }] }),
      { ok: true, value: { 2: [{ open: "10:00", close: "13:00" }, { open: "14:00", close: "19:00" }], 6: [{ open: "10:00", close: "24:00" }] } },
    );
  });

  it("넣지 않음(null)은 그대로 null — 영업시간 검사를 하지 않는 매장", () => {
    assert.deepEqual(validateBusinessHours(null), { ok: true, value: null });
  });

  it("빈 요일 목록은 키를 뺀다(그 요일은 영업하지 않음)", () => {
    assert.deepEqual(validateBusinessHours({ 1: [], 2: [{ open: "10:00", close: "19:00" }] }), {
      ok: true, value: { 2: [{ open: "10:00", close: "19:00" }] },
    });
  });

  it("잘못된 요일·시각·순서·겹침은 오류 위치와 함께 거부", () => {
    const cases: [unknown, string][] = [
      [{ 0: [{ open: "10:00", close: "19:00" }] }, "INVALID_WEEKDAY"],
      [{ 8: [{ open: "10:00", close: "19:00" }] }, "INVALID_WEEKDAY"],
      [{ 1: [{ open: "9:00", close: "19:00" }] }, "INVALID_TIME"],
      [{ 1: [{ open: "10:00", close: "24:30" }] }, "INVALID_TIME"],
      [{ 1: [{ open: "10:60", close: "19:00" }] }, "INVALID_TIME"],
      [{ 1: [{ open: "19:00", close: "10:00" }] }, "OPEN_NOT_BEFORE_CLOSE"],
      [{ 1: [{ open: "10:00", close: "10:00" }] }, "OPEN_NOT_BEFORE_CLOSE"],
      [{ 1: [{ open: "10:00", close: "14:00" }, { open: "13:00", close: "19:00" }] }, "WINDOWS_OVERLAP"],
      ["10:00-19:00", "INVALID_SHAPE"],
      [{ 1: "10:00" }, "INVALID_SHAPE"],
    ];
    for (const [input, code] of cases) {
      const r = validateBusinessHours(input);
      assert.equal(r.ok, false, JSON.stringify(input));
      assert.equal(!r.ok && r.error.code, code, JSON.stringify(input));
    }
  });

  it("요일 키는 1~7 한 글자만 — \"01\"·\" 1\"·\"1.0\"은 거부(같은 요일 키가 덮어쓰지 않게)", () => {
    for (const key of ["01", " 1", "1.0", "1e0"]) {
      const r = validateBusinessHours({ [key]: [{ open: "10:00", close: "19:00" }] });
      assert.equal(!r.ok && r.error.code, "INVALID_WEEKDAY", key);
    }
  });

  it("맞닿는 구간(13:00까지, 13:00부터)은 겹침이 아니다", () => {
    assert.equal(validateBusinessHours({ 1: [{ open: "10:00", close: "13:00" }, { open: "13:00", close: "19:00" }] }).ok, true);
  });
});

describe("휴무·휴가", () => {
  it("매주 요일 휴무", () => {
    assert.deepEqual(validateClosure({ kind: "weekly", weekday: 7 }), { ok: true, value: { kind: "weekly", weekday: 7 } });
    assert.equal(validateClosure({ kind: "weekly", weekday: 0 }).ok, false);
  });

  it("날짜 구간(공휴일·휴가) — 하루면 시작과 끝이 같다", () => {
    assert.deepEqual(validateClosure({ kind: "vacation", startDate: "2026-12-24", endDate: "2026-12-26" }), {
      ok: true, value: { kind: "vacation", startDate: "2026-12-24", endDate: "2026-12-26" },
    });
    assert.equal(validateClosure({ kind: "holiday", startDate: "2026-12-25", endDate: "2026-12-25" }).ok, true);
  });

  it("끝이 시작보다 앞이거나 없는 날짜, 모르는 종류는 거부", () => {
    const bad: [unknown, string][] = [
      [{ kind: "vacation", startDate: "2026-12-26", endDate: "2026-12-24" }, "START_AFTER_END"],
      [{ kind: "holiday", startDate: "2026-02-30", endDate: "2026-02-30" }, "INVALID_DATE"],
      [{ kind: "holiday", startDate: "2026/12/25", endDate: "2026-12-25" }, "INVALID_DATE"],
      [{ kind: "monthly", weekday: 1 }, "INVALID_SHAPE"],
      [{ kind: "weekly" }, "INVALID_WEEKDAY"],
    ];
    for (const [input, code] of bad) {
      const r = validateClosure(input);
      assert.equal(!r.ok && r.error.code, code, JSON.stringify(input));
    }
  });
});

describe("메뉴와 담당자", () => {
  it("메뉴: 이름 필수, 기본 관리 시간 1분 이상·기본 준비 시간 0분 이상 정수, 둘 다 비울 수 있다", () => {
    assert.deepEqual(validateMenu({ name: "  합성 관리 A ", defaultDurationMin: 60, defaultPrepMin: 10 }), {
      ok: true, value: { name: "합성 관리 A", defaultDurationMin: 60, defaultPrepMin: 10 },
    });
    assert.deepEqual(validateMenu({ name: "합성 관리 B" }), {
      ok: true, value: { name: "합성 관리 B", defaultDurationMin: null, defaultPrepMin: null },
    });
    assert.deepEqual(validateMenu({ name: "합성", defaultPrepMin: 0 }), {
      ok: true, value: { name: "합성", defaultDurationMin: null, defaultPrepMin: 0 },
    });
  });

  it("메뉴 오류는 필드별로 모두 모은다", () => {
    assert.deepEqual(validateMenu({ name: " ", defaultDurationMin: 0, defaultPrepMin: -5 }), {
      ok: false,
      errors: [
        { field: "name", code: "NAME_REQUIRED" },
        { field: "defaultDurationMin", code: "INVALID_MINUTES" },
        { field: "defaultPrepMin", code: "INVALID_MINUTES" },
      ],
    });
    assert.equal(validateMenu({ name: "합성", defaultDurationMin: 30.5 }).ok, false);
    // DB integer 상한 경계(#39 리뷰): 상한까지는 통과, 1 넘으면 입력 오류.
    assert.equal(validateMenu({ name: "합성", defaultDurationMin: MAX_MINUTES, defaultPrepMin: MAX_MINUTES }).ok, true);
    assert.deepEqual(validateMenu({ name: "합성", defaultDurationMin: MAX_MINUTES + 1, defaultPrepMin: MAX_MINUTES + 1 }), {
      ok: false,
      errors: [
        { field: "defaultDurationMin", code: "INVALID_MINUTES" },
        { field: "defaultPrepMin", code: "INVALID_MINUTES" },
      ],
    });
  });

  it("이름이 문자열이 아니어도 예외 없이 NAME_REQUIRED", () => {
    for (const name of [undefined, null, 1, {}]) {
      assert.deepEqual(validateStaff({ name } as never), { ok: false, errors: [{ field: "name", code: "NAME_REQUIRED" }] });
      assert.equal(validateMenu({ name } as never).ok, false);
    }
  });

  it("담당자: 이름 필수(원장 자신도 담당자로 등록 가능)", () => {
    assert.deepEqual(validateStaff({ name: " 원장 " }), { ok: true, value: { name: "원장" } });
    assert.deepEqual(validateStaff({ name: "" }), { ok: false, errors: [{ field: "name", code: "NAME_REQUIRED" }] });
  });
});
