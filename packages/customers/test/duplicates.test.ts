import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { type ExistingCustomer, checkSameName } from "../src/duplicates.ts";

// 합성 데이터. 같은 매장 고객 목록이라고 가정한다.
const existing: ExistingCustomer[] = [
  { id: "c1", name: "김하늘", phone: "01000001111" },
  { id: "c2", name: "김하늘", phone: null },
  { id: "c3", name: "김 하늘", phone: "01000002222" },
  { id: "c4", name: "이바다", phone: "01000001111" },
];

describe("checkSameName — BEA-12 동명이인 구분, 자동 병합 없음", () => {
  it("같은 이름이 없으면 확인 불필요", () => {
    assert.deepEqual(checkSameName({ name: "박구름", phone: null }, existing), { needsReview: false, candidates: [] });
  });

  it("같은 이름이 있으면 확인 필요 + 근거: 같은 번호 → 번호 없음 → 다른 번호 순", () => {
    const r = checkSameName({ name: "김하늘", phone: "01000001111" }, existing);
    assert.equal(r.needsReview, true);
    assert.deepEqual(
      r.candidates.map((c) => [c.customerId, c.hint]),
      [
        ["c1", "same_phone"],
        ["c2", "phone_missing"],
        ["c3", "different_phone"],
      ],
    );
  });

  it("전화번호가 같아도 병합 결정은 없다 — 후보와 근거만 돌려준다", () => {
    const r = checkSameName({ name: "김하늘", phone: "01000001111" }, existing);
    assert.deepEqual(Object.keys(r).sort(), ["candidates", "needsReview"]);
    assert.deepEqual(r.candidates[0], { customerId: "c1", name: "김하늘", phone: "01000001111", hint: "same_phone" });
  });

  it("새 고객에 번호가 없으면 모든 후보가 판단 근거 없음 — 그래도 생성은 막지 않는다(PD-50)", () => {
    const r = checkSameName({ name: "김하늘", phone: null }, existing);
    assert.equal(r.needsReview, true);
    assert.ok(r.candidates.every((c) => c.hint === "phone_missing"));
    assert.equal(r.candidates.length, 3);
  });

  it("이름이 다르면 전화번호가 같아도 동명이인 후보가 아니다", () => {
    const r = checkSameName({ name: "이바다", phone: "01000001111" }, existing);
    assert.deepEqual(
      r.candidates.map((c) => c.customerId),
      ["c4"],
    );
  });

  it("수정 중인 고객 자신은 후보에서 뺀다", () => {
    const r = checkSameName({ id: "c4", name: "이바다", phone: "01000001111" }, existing);
    assert.deepEqual(r, { needsReview: false, candidates: [] });
  });

  it("이름을 다른 동명이인 이름으로 고치면 확인 필요", () => {
    const r = checkSameName({ id: "c4", name: "김하늘", phone: "01000001111" }, existing);
    assert.equal(r.needsReview, true);
    assert.equal(r.candidates.length, 3);
  });

  it("같은 근거끼리는 입력 순서를 지킨다", () => {
    const list: ExistingCustomer[] = [
      { id: "b", name: "정새벽", phone: null },
      { id: "a", name: "정새벽", phone: null },
    ];
    assert.deepEqual(
      checkSameName({ name: "정새벽", phone: null }, list).candidates.map((c) => c.customerId),
      ["b", "a"],
    );
  });
});
