import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MAX_VALUE, signedDeltaFor, validateManualEntry, validatePassIssue } from "../src/wallet.ts";

// 합성 ID만 쓴다.
const CUSTOMER = "11111111-1111-4111-8111-111111111111";
const PASS = "22222222-2222-4222-8222-222222222222";
const MENU = "44444444-4444-4444-8444-444444444444";

describe("signedDeltaFor — 거래 종류가 부호를 정한다", () => {
  it("결제·보상 적립·차감취소는 양수", () => {
    for (const label of ["payment", "refund", "deduct_cancel"] as const) assert.equal(signedDeltaFor(label, 3), 3);
  });
  it("차감·결제취소는 음수", () => {
    for (const label of ["deduct", "payment_cancel"] as const) assert.equal(signedDeltaFor(label, 3), -3);
  });
  it("0·소수·음수 입력·상한 초과는 거부", () => {
    for (const value of [0, 1.5, -1, MAX_VALUE + 1, Number.NaN]) assert.equal(signedDeltaFor("payment", value), null, String(value));
  });
  it("장부 이관은 받은 부호를 보존하고 0은 거부", () => {
    assert.equal(signedDeltaFor("opening_balance", -5000), -5000);
    assert.equal(signedDeltaFor("opening_balance", 7), 7);
    assert.equal(signedDeltaFor("opening_balance", 0), null);
    assert.equal(signedDeltaFor("opening_balance", 0.5), null);
  });
});

describe("validateManualEntry — 웹 결제·차감 기록", () => {
  const base = { customerId: CUSTOMER, unitType: "sessions", passId: PASS, label: "deduct", value: 1 };

  it("횟수권 차감과 선불 결제를 받는다", () => {
    assert.deepEqual(validateManualEntry(base), { ok: true, value: { ...base, memo: null } });
    const prepaid = validateManualEntry({ customerId: CUSTOMER, unitType: "amount", label: "payment", value: 50000, memo: " 현금 " });
    assert.deepEqual(prepaid, { ok: true, value: { customerId: CUSTOMER, unitType: "amount", passId: null, label: "payment", value: 50000, memo: "현금" } });
  });

  it("0·소수·음수 value는 검증 오류", () => {
    for (const value of [0, 1.5, -3, "1"]) {
      const result = validateManualEntry({ ...base, value });
      assert.deepEqual(result, { ok: false, errors: [{ field: "value", code: "INVALID_VALUE" }] }, String(value));
    }
  });

  it("웹은 signedDelta·예약·회차를 지정할 수 없다", () => {
    const result = validateManualEntry({ ...base, signedDelta: -1, appointmentId: PASS, cycleSeq: 1 });
    assert.equal(result.ok, false);
    assert.deepEqual(!result.ok && result.errors.map((e) => e.field).sort(), ["appointmentId", "cycleSeq", "signedDelta"]);
  });

  it("CSV 전용 opening_balance와 12/01 범위 밖 종류는 거부", () => {
    for (const label of ["opening_balance", "refund", "deduct_cancel", "payment_cancel"]) {
      assert.deepEqual(validateManualEntry({ ...base, label }), { ok: false, errors: [{ field: "label", code: "INVALID_VALUE" }] }, label);
    }
  });

  it("횟수 단위는 passId 필수, 선불금은 passId를 받지 않는다", () => {
    const noPass = { ...base, passId: undefined };
    assert.deepEqual(validateManualEntry(noPass), { ok: false, errors: [{ field: "passId", code: "REQUIRED" }] });
    assert.deepEqual(validateManualEntry({ ...base, unitType: "amount" }), { ok: false, errors: [{ field: "passId", code: "MUST_BE_EMPTY" }] });
    assert.deepEqual(validateManualEntry({ ...base, unitType: "coins" }), { ok: false, errors: [{ field: "unitType", code: "INVALID_VALUE" }] });
  });

  it("객체가 아니면 INVALID_SHAPE", () => {
    assert.deepEqual(validateManualEntry([]), { ok: false, errors: [{ field: "", code: "INVALID_SHAPE" }] });
  });
});

describe("validatePassIssue — 웹 횟수권 구매·발급", () => {
  const base = { customerId: CUSTOMER, name: " 윤곽관리  10회권 ", menuId: MENU, sessions: 10, isPrimary: true };

  it("이름을 정리하고 대표 여부를 받는다", () => {
    assert.deepEqual(validatePassIssue(base), { ok: true, value: { ...base, name: "윤곽관리 10회권" } });
    const plain = { ...base, isPrimary: undefined };
    const result = validatePassIssue(plain);
    assert.ok(result.ok && result.value.isPrimary === false);
  });

  it("횟수는 1 이상 정수, 이름·메뉴는 필수", () => {
    assert.deepEqual(validatePassIssue({ ...base, sessions: 0 }), { ok: false, errors: [{ field: "sessions", code: "INVALID_VALUE" }] });
    assert.deepEqual(validatePassIssue({ ...base, name: "  " }), { ok: false, errors: [{ field: "name", code: "REQUIRED" }] });
    assert.deepEqual(validatePassIssue({ ...base, name: 3 }), { ok: false, errors: [{ field: "name", code: "INVALID_TYPE" }] });
    assert.deepEqual(validatePassIssue({ ...base, menuId: "x" }), { ok: false, errors: [{ field: "menuId", code: "INVALID_ID" }] });
  });

  it("모르는 필드는 거부", () => {
    assert.deepEqual(validatePassIssue({ ...base, price: 300000 }), { ok: false, errors: [{ field: "price", code: "UNKNOWN_FIELD" }] });
  });
});
