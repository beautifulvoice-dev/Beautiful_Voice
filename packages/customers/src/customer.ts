// 고객 입력 검증·정규화 (P2-02, 분해표 C-02). 외부 의존성 없는 순수 함수.
// 규칙 출처: Linear「MLP 범위·제품 결정」PD-50, BEA-12.
// - 고객은 이름만 필수. 전화번호는 권장이지만 없어도 만들 수 있다(PD-50).
// - 웹·마이크·채팅 모두 같은 검증을 쓴다. 어디서 왔는지는 이력의 source로만 구분한다(history.ts).
// 필드는 11/19 PM 데이터 스키마 전까지 최소로 둔다.
// ASSUMPTION: 이번 단계 필드는 이름·전화번호·메모 3개다. 나이·거주지·생년월일 등은 11/19 스키마 확정 후 추가한다.

export type PhoneKind = "mobile" | "landline";

export type CustomerField = "name" | "phone" | "memo";

export type CustomerErrorCode =
  | "NAME_REQUIRED" // 이름이 없거나 공백뿐
  | "PHONE_INVALID_CHARACTERS" // 숫자·구분 기호 외 문자가 섞임
  | "PHONE_INVALID_FORMAT"; // 숫자는 맞지만 국내 휴대폰·유선 형식이 아님

export interface FieldError {
  field: CustomerField;
  code: CustomerErrorCode;
}

/** 화면·마이크·채팅에서 들어온 원래 값. 빈 문자열은 "없음"으로 본다(이름 제외). */
export interface CustomerInput {
  name: string;
  phone?: string | null;
  memo?: string | null;
}

/** 저장할 정규화된 값. 전화번호는 숫자만(예: "01000000000"). */
export interface CustomerValues {
  name: string;
  phone: string | null;
  memo: string | null;
}

/** 수정 요청. undefined = 바꾸지 않음, null = 지움. 이름은 지울 수 없다. */
export interface CustomerPatch {
  name?: string;
  phone?: string | null;
  memo?: string | null;
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: FieldError[] };

/** 저장할 이름: 유니코드 NFC, 앞뒤 공백 제거, 연속 공백은 하나로. 빈 값이면 null. */
export function normalizeName(raw: string): string | null {
  const name = raw.normalize("NFC").trim().replace(/\s+/gu, " ");
  return name === "" ? null : name;
}

/**
 * 동명이인 비교용 키. 공백을 모두 지우고 소문자로 맞춘다("김 민지" = "김민지").
 * ASSUMPTION: 띄어쓰기·대소문자만 다른 이름은 같은 이름으로 본다. 넓게 잡아도 결과는 "확인 필요" 표시뿐이라 안전하다.
 */
export function nameKey(name: string): string {
  return name.normalize("NFC").replace(/\s+/gu, "").toLowerCase();
}

export type PhoneResult =
  | { ok: true; phone: string; kind: PhoneKind }
  | { ok: false; code: "PHONE_INVALID_CHARACTERS" | "PHONE_INVALID_FORMAT" };

// 구분 기호로 허용하는 문자. 이 밖의 문자(글자 등)가 있으면 숫자만 뽑지 않고 거절한다 — "010-1234-567o" 같은 오타를 조용히 바꾸지 않기 위해.
const PHONE_ALLOWED = /^\+?[\d\s\-.()]+$/u;

// ASSUMPTION: 국내 번호 형식(숫자만 기준).
// - 휴대폰: 010 + 8자리, 예전 번호 011·016·017·018·019 + 7~8자리.
// - 유선: 서울 02 + 7~8자리, 지역번호 031~033·041~044·051~055·061~064 + 7~8자리, 인터넷전화 070 + 8자리.
// - 대표번호(15xx·16xx·18xx 등)·수신자부담(080)은 고객 개인 번호가 아니라 받지 않는다.
const MOBILE = /^(?:010\d{8}|01[16789]\d{7,8})$/u;
const LANDLINE = /^(?:02\d{7,8}|0(?:3[1-3]|4[1-4]|5[1-5]|6[1-4])\d{7,8}|070\d{8})$/u;

/**
 * 전화번호를 숫자만 남겨 정규화하고 국내 휴대폰·유선 형식인지 확인한다. 빈 값 처리는 호출 측(validate*)이 한다.
 * 검사 전에 NFKC로 바꿔 전각 숫자·기호(STT·일부 키보드 입력, "０１０－…")를 표준 문자로 맞춘다.
 */
export function normalizePhone(raw: string): PhoneResult {
  const trimmed = raw.normalize("NFKC").trim();
  if (!PHONE_ALLOWED.test(trimmed)) return { ok: false, code: "PHONE_INVALID_CHARACTERS" };
  let digits = trimmed.replace(/\D/gu, "");
  // ASSUMPTION: +82로 시작하면 국가번호를 떼고 0을 붙인다(+82 10-… → 010-…, +82 (0)10-… 도 허용).
  if (trimmed.startsWith("+")) {
    if (!digits.startsWith("82")) return { ok: false, code: "PHONE_INVALID_FORMAT" };
    digits = digits.slice(2);
    if (!digits.startsWith("0")) digits = `0${digits}`;
  }
  if (MOBILE.test(digits)) return { ok: true, phone: digits, kind: "mobile" };
  if (LANDLINE.test(digits)) return { ok: true, phone: digits, kind: "landline" };
  return { ok: false, code: "PHONE_INVALID_FORMAT" };
}

/** 새 고객 입력 검증. 오류는 필드별로 모두 모아 돌려준다(화면이 한 번에 표시). */
export function validateNewCustomer(input: CustomerInput): ValidationResult<CustomerValues> {
  const errors: FieldError[] = [];
  const name = normalizeName(input.name);
  if (name === null) errors.push({ field: "name", code: "NAME_REQUIRED" });
  const phone = optionalPhone(input.phone, errors);
  if (errors.length > 0 || name === null) return { ok: false, errors };
  return { ok: true, value: { name, phone, memo: optionalText(input.memo) } };
}

/** 수정 요청 검증. 들어온 필드만 정규화해 돌려준다. 바뀐 게 있는지는 history.customerUpdated가 판단한다. */
export function validateCustomerPatch(patch: CustomerPatch): ValidationResult<CustomerPatch> {
  const errors: FieldError[] = [];
  const value: CustomerPatch = {};
  if (patch.name !== undefined) {
    const name = normalizeName(patch.name);
    if (name === null) errors.push({ field: "name", code: "NAME_REQUIRED" });
    else value.name = name;
  }
  if (patch.phone !== undefined) value.phone = optionalPhone(patch.phone, errors);
  if (patch.memo !== undefined) value.memo = optionalText(patch.memo);
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
}

/** 정규화된 수정 내용을 현재 값에 적용한다. */
export function applyPatch(current: CustomerValues, patch: CustomerPatch): CustomerValues {
  return {
    name: patch.name ?? current.name,
    phone: patch.phone === undefined ? current.phone : patch.phone,
    memo: patch.memo === undefined ? current.memo : patch.memo,
  };
}

function optionalPhone(raw: string | null | undefined, errors: FieldError[]): string | null {
  if (raw == null || raw.trim() === "") return null;
  const r = normalizePhone(raw);
  if (!r.ok) {
    errors.push({ field: "phone", code: r.code });
    return null;
  }
  return r.phone;
}

// ASSUMPTION: 메모는 앞뒤 공백만 지우고 줄바꿈 등 내용은 그대로 둔다. 길이 제한은 스키마 확정 후.
function optionalText(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const text = raw.normalize("NFC").trim();
  return text === "" ? null : text;
}
