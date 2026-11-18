import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { CustomerValues } from "../src/customer.ts";
import { type FieldChange, type HistoryContext, customerCreated, customerUpdated } from "../src/history.ts";

// 합성 데이터.
const NOW = new Date("2026-11-24T10:00:00+09:00");
const owner = (source: HistoryContext["source"] = "web"): HistoryContext => ({ actor: "owner", source, now: NOW });
const base: CustomerValues = { name: "김하늘", phone: "01000001111", memo: null };

describe("customerCreated", () => {
  it("값이 있는 필드만 from = null로 담는다", () => {
    assert.deepEqual(customerCreated(base, owner()), {
      type: "created",
      changes: [
        { field: "name", from: null, to: "김하늘" },
        { field: "phone", from: null, to: "01000001111" },
      ],
      actor: "owner",
      source: "web",
      at: NOW,
    });
  });
  it("마이크·채팅 변경안 승인도 actor는 원장, 출처만 다르다(절대 규칙 3)", () => {
    for (const source of ["voice", "chat"] as const) {
      const e = customerCreated(base, owner(source));
      assert.equal(e.actor, "owner");
      assert.equal(e.source, source);
    }
  });
  it("가져오기는 시스템이 import로 남긴다, reason은 있을 때만", () => {
    const e = customerCreated(base, { actor: "system", source: "import", now: NOW, reason: "샘플 시드" });
    assert.equal(e.actor, "system");
    assert.equal(e.source, "import");
    assert.equal(e.reason, "샘플 시드");
    assert.equal("reason" in customerCreated(base, owner()), false);
  });
});

describe("customerUpdated", () => {
  const cases: [string, CustomerValues, FieldChange[]][] = [
    ["전화번호만 변경", { ...base, phone: "01000002222" }, [{ field: "phone", from: "01000001111", to: "01000002222" }]],
    ["전화번호 지움", { ...base, phone: null }, [{ field: "phone", from: "01000001111", to: null }]],
    [
      "이름·메모 함께 변경",
      { ...base, name: "김하나", memo: "메모" },
      [
        { field: "name", from: "김하늘", to: "김하나" },
        { field: "memo", from: null, to: "메모" },
      ],
    ],
  ];
  for (const [label, after, changes] of cases) {
    it(label, () => {
      const e = customerUpdated(base, after, owner());
      assert.ok(e);
      assert.equal(e.type, "updated");
      assert.deepEqual(e.changes, changes);
    });
  }
  it("바뀐 게 없으면 이력 없음", () => {
    assert.equal(customerUpdated(base, { ...base }, owner()), null);
  });
});
