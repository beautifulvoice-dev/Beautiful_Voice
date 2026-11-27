// 매장 설정 입력 검사 — BEA-166(영업시간·휴무)·BEA-167(메뉴·담당자). 명세 3 기능 2A-1.1~2A-1.4, 명세 2 §2.3. 외부 의존성 없는 순수 함수.
// 여기서 검사를 통과한 값만 shop_settings.business_hours·shop_closure·menu·staff에 저장한다.
// 영업시간 형식은 예약 저장 검사(booking.ts, BEA-177)가 그대로 읽는다.
// 설정은 사람만 바꾼다 — AI 실행기에는 설정 쓰기 권한이 없다(결정 R0, DB 권한은 BEA-156).

import type { BusinessHours, Closure, OpenWindow } from "./booking.ts";
import { CLEANUP_RANGE, DURATION_RANGE, minutesWithin } from "./warnings.ts";

type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export type SettingsErrorCode =
  | "INVALID_SHAPE"
  | "INVALID_WEEKDAY"
  | "INVALID_TIME"
  | "OPEN_NOT_BEFORE_CLOSE"
  | "WINDOWS_OVERLAP"
  | "INVALID_DATE"
  | "START_AFTER_END";

export interface SettingsError {
  code: SettingsErrorCode;
  /** 문제 위치(예: "2[1]" = 화요일 두 번째 구간). 화면이 해당 칸을 표시하는 데 쓴다. */
  at?: string;
}

export type SettingsResult<T> = { ok: true; value: T } | { ok: false; error: SettingsError };

const HHMM = /^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/u;
const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/**
 * 영업시간 검사. null은 "넣지 않음"(예약 저장 검사가 영업시간을 보지 않는 매장)이다.
 * ASSUMPTION(명세가 개발팀에 맡긴 형식): 요일(1=월 … 7=일)별 {open, close} 목록. 시각은 서울 "HH:MM", close는 "24:00"까지.
 * 한 요일에 여러 구간(점심시간 등)을 둘 수 있고 겹치면 안 된다. 빈 목록은 키를 빼서 "그 요일 영업 안 함"으로 저장한다.
 */
export function validateBusinessHours(input: unknown): SettingsResult<BusinessHours | null> {
  if (input === null) return { ok: true, value: null };
  if (typeof input !== "object" || Array.isArray(input)) return fail("INVALID_SHAPE");
  const value: BusinessHours = {};
  for (const [key, windows] of Object.entries(input as Record<string, unknown>)) {
    // "01"·" 1"·"1.0"처럼 같은 요일로 바뀌는 키가 서로 덮어쓰지 않게 키 모양을 엄격히 본다(#39 리뷰).
    if (!/^[1-7]$/u.test(key)) return fail("INVALID_WEEKDAY", key);
    const weekday = Number(key) as Weekday;
    if (!Array.isArray(windows)) return fail("INVALID_SHAPE", key);
    const clean: OpenWindow[] = [];
    for (const [i, w] of windows.entries()) {
      const at = `${key}[${i}]`;
      if (typeof w !== "object" || w === null) return fail("INVALID_SHAPE", at);
      const { open, close } = w as Record<string, unknown>;
      if (typeof open !== "string" || typeof close !== "string" || !HHMM.test(open) || !HHMM.test(close) || open === "24:00") {
        return fail("INVALID_TIME", at);
      }
      if (minutes(open) >= minutes(close)) return fail("OPEN_NOT_BEFORE_CLOSE", at);
      clean.push({ open, close });
    }
    clean.sort((a, b) => minutes(a.open) - minutes(b.open));
    for (let i = 1; i < clean.length; i++) {
      if (minutes(clean[i]!.open) < minutes(clean[i - 1]!.close)) return fail("WINDOWS_OVERLAP", key);
    }
    if (clean.length > 0) value[weekday] = clean;
  }
  return { ok: true, value };
}

/** 휴무 한 건(shop_closure 한 행). 매주 요일 또는 날짜 구간(공휴일·휴가, 시작·끝 포함). */
export function validateClosure(input: unknown): SettingsResult<Closure> {
  if (typeof input !== "object" || input === null) return fail("INVALID_SHAPE");
  const c = input as Record<string, unknown>;
  if (c.kind === "weekly") {
    return isWeekday(c.weekday) ? { ok: true, value: { kind: "weekly", weekday: c.weekday } } : fail("INVALID_WEEKDAY");
  }
  if (c.kind === "holiday" || c.kind === "vacation") {
    if (!isDate(c.startDate) || !isDate(c.endDate)) return fail("INVALID_DATE");
    if (c.startDate > c.endDate) return fail("START_AFTER_END");
    return { ok: true, value: { kind: c.kind, startDate: c.startDate, endDate: c.endDate } };
  }
  return fail("INVALID_SHAPE");
}

// ── 메뉴·담당자 ───────────────────────────────────────

export type ResourceField = "name" | "defaultDurationMin" | "defaultCleanupMin" | "defaultPrice" | "defaultPrepMin";
export type ResourceErrorCode = "NAME_REQUIRED" | "INVALID_MINUTES" | "INVALID_PRICE" | "DUPLICATE_FIELD";
export type ResourceResult<T> = { ok: true; value: T } | { ok: false; errors: { field: ResourceField; code: ResourceErrorCode }[] };

/** 원 단위 가격 상한 = DB integer 최댓값(015 menu.default_price). */
export const MAX_PRICE = 2_147_483_647;

export interface MenuValues {
  name: string;
  /** 예약 입력을 미리 채우는 기본 시술 시간(분, 5~600). 비울 수 있다(결정 S3). */
  defaultDurationMin: number | null;
  /** 기본 정리 시간(분, 시술 뒤 0~180 — rev.3.1). 비울 수 있다. */
  defaultCleanupMin: number | null;
  /** 원 단위 정수(0 이상). 비우면 0. */
  defaultPrice: number;
  /** @deprecated S3 전환 기간의 옛 이름 — defaultCleanupMin과 같은 값. 웹 전환(S3 ③) 뒤 지운다. */
  defaultPrepMin: number | null;
}

export function validateMenu(input: {
  name: string;
  defaultDurationMin?: number | null;
  defaultCleanupMin?: number | null;
  /** @deprecated defaultCleanupMin의 옛 이름. 둘 다 보내면 DUPLICATE_FIELD. */
  defaultPrepMin?: number | null;
  defaultPrice?: number | null;
}): ResourceResult<MenuValues> {
  const errors: { field: ResourceField; code: ResourceErrorCode }[] = [];
  const name = cleanName(input.name);
  if (name === null) errors.push({ field: "name", code: "NAME_REQUIRED" });
  const duration = input.defaultDurationMin ?? null;
  if (duration !== null && !minutesWithin(duration, DURATION_RANGE)) errors.push({ field: "defaultDurationMin", code: "INVALID_MINUTES" });
  if (input.defaultCleanupMin !== undefined && input.defaultPrepMin !== undefined) errors.push({ field: "defaultPrepMin", code: "DUPLICATE_FIELD" });
  const legacy = input.defaultCleanupMin === undefined && input.defaultPrepMin !== undefined;
  const cleanup = (legacy ? input.defaultPrepMin : input.defaultCleanupMin) ?? null;
  if (cleanup !== null && !minutesWithin(cleanup, CLEANUP_RANGE)) {
    errors.push({ field: legacy ? "defaultPrepMin" : "defaultCleanupMin", code: "INVALID_MINUTES" });
  }
  const price = input.defaultPrice ?? 0;
  if (!(Number.isInteger(price) && price >= 0 && price <= MAX_PRICE)) errors.push({ field: "defaultPrice", code: "INVALID_PRICE" });
  if (errors.length > 0 || name === null) return { ok: false, errors };
  return { ok: true, value: { name, defaultDurationMin: duration, defaultCleanupMin: cleanup, defaultPrice: price, defaultPrepMin: cleanup } };
}

/** 담당자는 로그인하지 않는 예약 자원이다. 원장 자신도 담당자로 등록할 수 있다(파생 R20). */
export function validateStaff(input: { name: string }): ResourceResult<{ name: string }> {
  const name = cleanName(input.name);
  return name === null ? { ok: false, errors: [{ field: "name", code: "NAME_REQUIRED" }] } : { ok: true, value: { name } };
}

// ── 매장 안내 정보(shop_settings) ──────────────────────

export type ShopInfoField = "refundPolicy" | "naverPlaceUrl" | "instagramUrl" | "landingUrl" | "locationText";
export type ShopInfoErrorCode = "INVALID_TEXT" | "INVALID_URL";
export type ShopInfoValues = Record<ShopInfoField, string | null>;
export type ShopInfoResult = { ok: true; value: ShopInfoValues } | { ok: false; errors: { field: ShopInfoField; code: ShopInfoErrorCode }[] };

const TEXT_FIELDS = ["refundPolicy", "locationText"] as const;
const URL_FIELDS = ["naverPlaceUrl", "instagramUrl", "landingUrl"] as const;

/**
 * 환불 정책·매장 링크 3개·위치(BEA-166). 5칸을 모두 받아 통째로 저장한다(#42 PUT settings/shop-info).
 * 빈 글·공백만 있는 글은 null(비우기)로 저장한다. 글은 앞뒤 공백만 정리하고 줄바꿈은 그대로 둔다(환불 정책은 여러 줄).
 * ASSUMPTION: 링크는 http·https 주소만 — 고객에게 보여 줄 링크라 javascript: 같은 주소를 막는다(#42). 길이 제한은 명세에 없어 두지 않는다.
 */
export function validateShopInfo(input: unknown): ShopInfoResult {
  const errors: { field: ShopInfoField; code: ShopInfoErrorCode }[] = [];
  const body = typeof input === "object" && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const value = {} as ShopInfoValues;
  for (const field of TEXT_FIELDS) {
    const text = cleanText(body[field]);
    if (text === undefined) errors.push({ field, code: "INVALID_TEXT" });
    else value[field] = text;
  }
  for (const field of URL_FIELDS) {
    const text = cleanText(body[field]);
    if (text === undefined) errors.push({ field, code: "INVALID_TEXT" });
    else if (text !== null && !isWebLink(text)) errors.push({ field, code: "INVALID_URL" });
    else value[field] = text;
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
}

// ── 내부 ──────────────────────────────────────────────

function fail<T>(code: SettingsErrorCode, at?: string): SettingsResult<T> {
  return { ok: false, error: at === undefined ? { code } : { code, at } };
}

function isWeekday(v: unknown): v is Weekday {
  return Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 7;
}

function isDate(v: unknown): v is string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(v)) return false;
  const [y, m, d] = v.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).toISOString().slice(0, 10) === v;
}

// API 경계에서 문자열이 아닌 값이 들어와도 예외 대신 "이름 없음"으로 처리한다(#39 리뷰).
function cleanName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.normalize("NFC").trim().replace(/\s+/gu, " ");
  return name === "" ? null : name;
}

/** null·빈 글 → null, 글 → 앞뒤 공백 정리, 그 밖(숫자·빠진 칸 등) → undefined(잘못됨). */
function cleanText(raw: unknown): string | null | undefined {
  if (raw === null) return null;
  if (typeof raw !== "string") return undefined;
  const text = raw.normalize("NFC").trim();
  return text === "" ? null : text;
}

function isWebLink(text: string): boolean {
  if (!/^https?:\/\//iu.test(text) || /\s/u.test(text)) return false;
  try {
    const url = new URL(text);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname !== "";
  } catch {
    return false;
  }
}
