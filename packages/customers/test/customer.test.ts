import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  type PhoneKind,
  applyPatch,
  nameKey,
  normalizeName,
  normalizePhone,
  validateCustomerPatch,
  validateNewCustomer,
} from "../src/customer.ts";

// 합성 데이터만 쓴다. 전화번호는 0000·1111 같은 가짜 자리, 이름은 흔한 가명.

describe("normalizeName", () => {
  const cases: [string, string, string | null][] = [
    ["앞뒤 공백 제거", "  김하늘  ", "김하늘"],
    ["가운데 연속 공백은 하나로", "김  하늘", "김 하늘"],
    ["탭·줄바꿈도 공백", "\t김하늘\n", "김하늘"],
    ["빈 문자열은 없음", "", null],
    ["공백뿐이면 없음", "   ", null],
    ["NFD(자모 분리)로 들어와도 NFC로 저장", "김하늘".normalize("NFD"), "김하늘"],
  ];
  for (const [label, raw, expected] of cases) it(label, () => assert.equal(normalizeName(raw), expected));
});

describe("nameKey — 동명이인 비교 키", () => {
  const same: [string, string, string][] = [
    ["띄어쓰기만 다름", "김 하늘", "김하늘"],
    ["자모 분리 여부만 다름", "김하늘".normalize("NFD"), "김하늘"],
    ["영문 대소문자만 다름", "Jamie Lee", "jamie lee"],
  ];
  for (const [label, a, b] of same) it(`같은 키: ${label}`, () => assert.equal(nameKey(a), nameKey(b)));
  it("글자가 다르면 다른 키", () => assert.notEqual(nameKey("김하늘"), nameKey("김하눌")));
});

describe("normalizePhone — 숫자만 남기고 국내 휴대폰·유선만 받는다", () => {
  const ok: [string, string, string, PhoneKind][] = [
    ["휴대폰 하이픈", "010-0000-1111", "01000001111", "mobile"],
    ["휴대폰 공백·점", "010 0000.1111", "01000001111", "mobile"],
    ["휴대폰 숫자만", "01000001111", "01000001111", "mobile"],
    ["예전 휴대폰 10자리", "011-000-1111", "0110001111", "mobile"],
    ["예전 휴대폰 11자리", "019-0000-1111", "01900001111", "mobile"],
    ["+82 국가번호", "+82 10-0000-1111", "01000001111", "mobile"],
    ["+82 (0) 표기", "+82 (0)10-0000-1111", "01000001111", "mobile"],
    ["서울 9자리", "02-000-1111", "020001111", "landline"],
    ["서울 10자리", "(02) 0000-1111", "0200001111", "landline"],
    ["지역번호 10자리", "051-000-1111", "0510001111", "landline"],
    ["지역번호 11자리", "031-0000-1111", "03100001111", "landline"],
    ["인터넷전화", "070-0000-1111", "07000001111", "landline"],
    ["전각 숫자(STT·키보드)", "０１０-0000-1111", "01000001111", "mobile"],
    ["전각 숫자·하이픈·괄호", "（０２）０００－１１１１", "020001111", "landline"],
  ];
  for (const [label, raw, phone, kind] of ok) {
    it(`통과: ${label}`, () => assert.deepEqual(normalizePhone(raw), { ok: true, phone, kind }));
  }

  const bad: [string, string, "PHONE_INVALID_CHARACTERS" | "PHONE_INVALID_FORMAT"][] = [
    ["글자 섞임(오타를 조용히 지우지 않음)", "010-0000-111o", "PHONE_INVALID_CHARACTERS"],
    ["내선 표기", "02-000-1111 ext 2", "PHONE_INVALID_CHARACTERS"],
    ["+가 가운데", "010+0000+1111", "PHONE_INVALID_CHARACTERS"],
    ["전각이어도 글자 섞이면 거절", "０１０-0000-111ｏ", "PHONE_INVALID_CHARACTERS"],
    ["050x 안심번호(PM 확인 필요)", "0507-0000-1111", "PHONE_INVALID_FORMAT"],
    ["010인데 7자리", "010-000-1111", "PHONE_INVALID_FORMAT"],
    ["010인데 9자리", "010-00000-1111", "PHONE_INVALID_FORMAT"],
    ["0 없이 시작", "10-0000-1111", "PHONE_INVALID_FORMAT"],
    ["없는 지역번호", "039-000-1111", "PHONE_INVALID_FORMAT"],
    ["서울 6자리", "02-00-1111", "PHONE_INVALID_FORMAT"],
    ["대표번호", "1588-0000", "PHONE_INVALID_FORMAT"],
    ["수신자부담", "080-000-1111", "PHONE_INVALID_FORMAT"],
    ["해외 번호", "+1 000-000-1111", "PHONE_INVALID_FORMAT"],
    ["구분 기호뿐", "---", "PHONE_INVALID_FORMAT"],
  ];
  for (const [label, raw, code] of bad) {
    it(`거절: ${label}`, () => assert.deepEqual(normalizePhone(raw), { ok: false, code }));
  }
});

describe("validateNewCustomer — PD-50 이름만 필수", () => {
  it("이름만으로 만들 수 있다", () => {
    assert.deepEqual(validateNewCustomer({ name: " 김하늘 " }), {
      ok: true,
      value: { name: "김하늘", phone: null, memo: null },
    });
  });
  it("전화번호·메모가 빈 문자열·null이면 없음", () => {
    for (const empty of ["", "   ", null]) {
      const r = validateNewCustomer({ name: "김하늘", phone: empty, memo: empty });
      assert.deepEqual(r, { ok: true, value: { name: "김하늘", phone: null, memo: null } });
    }
  });
  it("전화번호·메모를 정규화한다", () => {
    const r = validateNewCustomer({ name: "김하늘", phone: "010-0000-1111", memo: "  민감성 피부\n재방문 희망  " });
    assert.deepEqual(r, { ok: true, value: { name: "김하늘", phone: "01000001111", memo: "민감성 피부\n재방문 희망" } });
  });
  it("이름이 없으면 NAME_REQUIRED", () => {
    assert.deepEqual(validateNewCustomer({ name: "  " }), { ok: false, errors: [{ field: "name", code: "NAME_REQUIRED" }] });
  });
  it("이름·전화번호 오류를 함께 돌려준다", () => {
    assert.deepEqual(validateNewCustomer({ name: "", phone: "010-000" }), {
      ok: false,
      errors: [
        { field: "name", code: "NAME_REQUIRED" },
        { field: "phone", code: "PHONE_INVALID_FORMAT" },
      ],
    });
  });
});

describe("validateCustomerPatch·applyPatch — 수정", () => {
  const current = { name: "김하늘", phone: "01000001111", memo: "첫 방문" };

  it("들어온 필드만 바꾼다", () => {
    const r = validateCustomerPatch({ memo: " 두 번째 방문 " });
    assert.deepEqual(r, { ok: true, value: { memo: "두 번째 방문" } });
    assert.ok(r.ok);
    assert.deepEqual(applyPatch(current, r.value), { ...current, memo: "두 번째 방문" });
  });
  it("전화번호·메모는 null 또는 빈 값으로 지울 수 있다", () => {
    for (const empty of [null, ""]) {
      const r = validateCustomerPatch({ phone: empty, memo: empty });
      assert.ok(r.ok);
      assert.deepEqual(applyPatch(current, r.value), { name: "김하늘", phone: null, memo: null });
    }
  });
  it("빈 수정 요청은 아무것도 바꾸지 않는다", () => {
    const r = validateCustomerPatch({});
    assert.ok(r.ok);
    assert.deepEqual(applyPatch(current, r.value), current);
  });
  it("이름을 빈 값으로 바꿀 수 없다", () => {
    assert.deepEqual(validateCustomerPatch({ name: " " }), { ok: false, errors: [{ field: "name", code: "NAME_REQUIRED" }] });
  });
  it("잘못된 전화번호는 거절", () => {
    assert.deepEqual(validateCustomerPatch({ phone: "abc" }), {
      ok: false,
      errors: [{ field: "phone", code: "PHONE_INVALID_CHARACTERS" }],
    });
  });
});
