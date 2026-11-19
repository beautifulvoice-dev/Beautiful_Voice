// BEA-172(고객 등록·수정)·BEA-173(비활성화·재활성화) — 11/19 명세 1 §2.3, 명세 2 §2.4 customer.
// 합성 데이터만 쓴다.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { applyPatch, validateCustomerPatch, validateNewCustomer } from "../src/customer.ts";
import { changeActive } from "../src/activation.ts";

describe("새 필드: 생년월일·거주지", () => {
  it("이름만으로 등록되고 나머지는 null", () => {
    assert.deepEqual(validateNewCustomer({ name: "김하늘" }), {
      ok: true,
      value: { name: "김하늘", phone: null, memo: null, birthdate: null, address: null },
    });
  });

  it("생년월일은 실제 있는 날짜 YYYY-MM-DD, 거주지는 앞뒤 공백만 정리", () => {
    const r = validateNewCustomer({ name: "김하늘", birthdate: " 1990-02-28 ", address: "  합성시 가상구  " });
    assert.deepEqual(r.ok && { b: r.value.birthdate, a: r.value.address }, { b: "1990-02-28", a: "합성시 가상구" });
    assert.equal(validateNewCustomer({ name: "김하늘", birthdate: "2000-02-29" }).ok, true);
  });

  it("없는 날짜나 다른 형식은 BIRTHDATE_INVALID", () => {
    for (const bad of ["1990-02-30", "2001-02-29", "1990-13-01", "19900228", "1990/02/28", "90-02-28"]) {
      assert.deepEqual(validateNewCustomer({ name: "김하늘", birthdate: bad }), {
        ok: false, errors: [{ field: "birthdate", code: "BIRTHDATE_INVALID" }],
      }, bad);
    }
  });

  it("빈 값은 없음으로 본다", () => {
    const r = validateNewCustomer({ name: "김하늘", birthdate: "  ", address: "" });
    assert.deepEqual(r.ok && [r.value.birthdate, r.value.address], [null, null]);
  });

  it("수정: 들어온 필드만 바꾸고 null은 지운다", () => {
    const current = { name: "김하늘", phone: null, memo: null, birthdate: "1990-02-28", address: "합성시" };
    const patch = validateCustomerPatch({ birthdate: null, address: "가상시" });
    assert.ok(patch.ok);
    assert.deepEqual(applyPatch(current, patch.value), { ...current, birthdate: null, address: "가상시" });
    assert.deepEqual(validateCustomerPatch({ birthdate: "1990-02-30" }), {
      ok: false, errors: [{ field: "birthdate", code: "BIRTHDATE_INVALID" }],
    });
  });

  it("예전 값(생년월일·거주지 없음)에 수정해도 기존 필드는 그대로", () => {
    const legacy = { name: "김하늘", phone: "01000000000", memo: "합성 메모" };
    assert.deepEqual(applyPatch(legacy, { name: "김하늘2" }), { ...legacy, name: "김하늘2", birthdate: null, address: null });
  });
});

describe("비활성화·재활성화 (AC-CRM-4, 결정 R30·S4)", () => {
  const at = new Date("2026-11-20T01:00:00Z");

  it("삭제는 비활성화 — 시각을 남긴다", () => {
    assert.deepEqual(changeActive({ active: true, deactivatedAt: null }, false, at), {
      ok: true, value: { active: false, deactivatedAt: at },
    });
  });

  it("재활성화하면 시각을 비운다", () => {
    assert.deepEqual(changeActive({ active: false, deactivatedAt: at }, true, at), {
      ok: true, value: { active: true, deactivatedAt: null },
    });
  });

  it("같은 상태로 바꾸는 것은 변경이 아니다", () => {
    assert.deepEqual(changeActive({ active: true, deactivatedAt: null }, true, at), { ok: false, error: "NO_CHANGE" });
    assert.deepEqual(changeActive({ active: false, deactivatedAt: at }, false, at), { ok: false, error: "NO_CHANGE" });
  });
});
