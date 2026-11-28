// 지갑 거래 규칙(설계 13 §2-2·§3·§6) — DB 없이 도는 순수 함수. 서버의 공통 지갑 서비스가 웹·CSV·S6 모든 경로에서 쓴다.
// 부호는 서버가 거래 종류로 정한다. 웹은 양수 value만 보내고, signedDelta·예약·회차·CSV 전용 종류를 지정할 수 없다.
// DB CHECK(017 wallet_entry_label_sign)와 같은 규칙이다 — 여기서 먼저 걸러 422로 돌려주고, DB가 마지막에 한 번 더 막는다.

export type UnitType = "amount" | "sessions";

export type EntryLabel = "payment" | "deduct" | "opening_balance" | "refund" | "deduct_cancel" | "payment_cancel";

/** 12/01 웹 일반 쓰기에서 받는 종류. 나머지는 DB 표현 범위만(설계 13 §2-2 표). */
export type ManualLabel = "payment" | "deduct";

/** DB 칸이 integer라 넘으면 저장 오류(500)가 난다. 업무 상한이 아니라 기술 상한이다. */
export const MAX_VALUE = 2_147_483_647;

const POSITIVE: ReadonlySet<EntryLabel> = new Set(["payment", "refund", "deduct_cancel"]);
const NEGATIVE: ReadonlySet<EntryLabel> = new Set(["deduct", "payment_cancel"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type WalletErrorCode = "INVALID_SHAPE" | "UNKNOWN_FIELD" | "REQUIRED" | "INVALID_TYPE" | "INVALID_ID" | "INVALID_VALUE" | "MUST_BE_EMPTY" | "NOT_FOUND";

export interface FieldError {
  field: string;
  code: WalletErrorCode;
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: FieldError[] };

export function isValue(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_VALUE;
}

/**
 * 거래 종류와 양수 크기로 부호 있는 변화량을 정한다. opening_balance는 받은 부호를 그대로 쓴다(0 제외).
 * 규칙에 맞지 않으면 null — 0·소수·범위 밖, 또는 opening_balance가 아닌데 음수를 넘긴 경우.
 */
export function signedDeltaFor(label: EntryLabel, value: number): number | null {
  if (label === "opening_balance") {
    return Number.isInteger(value) && value !== 0 && Math.abs(value) <= MAX_VALUE ? value : null;
  }
  if (!isValue(value)) return null;
  if (POSITIVE.has(label)) return value;
  if (NEGATIVE.has(label)) return -value;
  return null;
}

/** 웹 결제·차감 기록 요청(설계 13 §4 POST /api/wallet-entries 본문). */
export interface ManualEntryInput {
  customerId: string;
  unitType: UnitType;
  passId: string | null;
  label: ManualLabel;
  value: number;
  memo: string | null;
}

const MANUAL_FIELDS = new Set(["customerId", "unitType", "passId", "label", "value", "memo"]);

export function validateManualEntry(input: unknown): ValidationResult<ManualEntryInput> {
  if (!isObject(input)) return { ok: false, errors: [{ field: "", code: "INVALID_SHAPE" }] };
  const errors = unknownFields(input, MANUAL_FIELDS);
  const customerId = readId(input, "customerId", errors);
  const unitType = input.unitType;
  if (unitType === undefined) errors.push({ field: "unitType", code: "REQUIRED" });
  else if (unitType !== "amount" && unitType !== "sessions") errors.push({ field: "unitType", code: "INVALID_VALUE" });
  let passId: string | null = null;
  if (unitType === "sessions") passId = readId(input, "passId", errors);
  else if (unitType === "amount" && input.passId !== undefined && input.passId !== null) {
    errors.push({ field: "passId", code: "MUST_BE_EMPTY" });
  }
  const label = input.label;
  if (label === undefined) errors.push({ field: "label", code: "REQUIRED" });
  else if (label !== "payment" && label !== "deduct") errors.push({ field: "label", code: "INVALID_VALUE" });
  if (input.value === undefined) errors.push({ field: "value", code: "REQUIRED" });
  else if (!isValue(input.value)) errors.push({ field: "value", code: "INVALID_VALUE" });
  const memo = readMemo(input, errors);
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: { customerId: customerId!, unitType: unitType as UnitType, passId, label: label as ManualLabel, value: input.value as number, memo },
  };
}

/** 웹 횟수권 구매·발급 요청(설계 13 §4 POST /api/passes 본문). 웹에서는 메뉴 연결이 필수다. */
export interface PassIssueInput {
  customerId: string;
  name: string;
  menuId: string;
  sessions: number;
  isPrimary: boolean;
}

const PASS_FIELDS = new Set(["customerId", "name", "menuId", "sessions", "isPrimary"]);

export function validatePassIssue(input: unknown): ValidationResult<PassIssueInput> {
  if (!isObject(input)) return { ok: false, errors: [{ field: "", code: "INVALID_SHAPE" }] };
  const errors = unknownFields(input, PASS_FIELDS);
  const customerId = readId(input, "customerId", errors);
  const menuId = readId(input, "menuId", errors);
  const name = typeof input.name === "string" ? normalizePassName(input.name) : null;
  if (input.name !== undefined && typeof input.name !== "string") errors.push({ field: "name", code: "INVALID_TYPE" });
  else if (name === null) errors.push({ field: "name", code: "REQUIRED" });
  if (input.sessions === undefined) errors.push({ field: "sessions", code: "REQUIRED" });
  else if (!isValue(input.sessions)) errors.push({ field: "sessions", code: "INVALID_VALUE" });
  if (input.isPrimary !== undefined && typeof input.isPrimary !== "boolean") errors.push({ field: "isPrimary", code: "INVALID_TYPE" });
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: { customerId: customerId!, name: name!, menuId: menuId!, sessions: input.sessions as number, isPrimary: input.isPrimary === true },
  };
}

/** 앞뒤 공백 제거·NFC. 빈 값이면 null. */
export function normalizePassName(raw: string): string | null {
  const name = raw.normalize("NFC").trim().replace(/\s+/gu, " ");
  return name === "" ? null : name;
}

function isObject(input: unknown): input is Record<string, unknown> {
  return input !== null && typeof input === "object" && !Array.isArray(input);
}

function unknownFields(input: Record<string, unknown>, allowed: ReadonlySet<string>): FieldError[] {
  return Object.keys(input).filter((key) => !allowed.has(key)).map((field) => ({ field, code: "UNKNOWN_FIELD" }));
}

function readId(input: Record<string, unknown>, field: string, errors: FieldError[]): string | null {
  const value = input[field];
  if (value === undefined || value === null) errors.push({ field, code: "REQUIRED" });
  else if (typeof value !== "string" || !UUID.test(value)) errors.push({ field, code: "INVALID_ID" });
  else return value.toLowerCase();
  return null;
}

function readMemo(input: Record<string, unknown>, errors: FieldError[]): string | null {
  if (input.memo === undefined || input.memo === null) return null;
  if (typeof input.memo !== "string") {
    errors.push({ field: "memo", code: "INVALID_TYPE" });
    return null;
  }
  const memo = input.memo.trim();
  return memo === "" ? null : memo;
}
