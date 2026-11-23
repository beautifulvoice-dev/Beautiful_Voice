// 저장이 실패했을 때 화면이 보여 줄 것. 오류 종류(클래스)를 원장이 읽을 문장과 칸 표시로 바꾼다.
import type { ResourceField } from '@bv/scheduling/shop-settings';
import { HttpError } from '@/lib/http';
import { FieldsInvalidError, SettingsInvalidError, SettingsNotFoundError, VersionConflictError } from './api';
import { CONFLICT_TEXT, fieldErrorText, SETTINGS_ERROR_TEXT } from './messages';

export type SaveProblem =
  /** 메뉴·담당자 칸 오류 — 칸 아래에 문구를 단다. */
  | { kind: 'fields'; fields: Partial<Record<ResourceField, string>> }
  /** 영업시간·휴무 오류 — at은 문제 위치(예 "2[0]"), 해당 줄을 표시하는 데 쓴다. */
  | { kind: 'settings'; message: string; at?: string }
  /** 다른 곳에서 먼저 고침 — 다시 불러와야 한다. */
  | { kind: 'conflict'; message: string }
  /** 이미 지워진 항목 — 목록을 다시 불러와야 한다. */
  | { kind: 'gone'; message: string }
  /** 서버가 쓰기를 거절함(세션 만료·4xx 등) — 이 키는 끝났으니 다음 저장은 새 키를 쓴다(#72 리뷰). */
  | { kind: 'rejected'; message: string }
  /** 연결 끊김·5xx 등 저장됐는지 모름 — 같은 키로 다시 보내야 중복 등록이 안 된다(#75 리뷰). */
  | { kind: 'failed'; message: string };

export const GONE_TEXT = '이미 지워진 항목이에요. 목록을 새로 불러왔어요.';
export const FAILED_TEXT = '저장하지 못했어요. 인터넷 연결을 확인한 뒤 다시 시도해 주세요.';
export const REJECTED_TEXT = '저장하지 못했어요. 잠시 뒤 다시 시도해 주세요.';

export function toSaveProblem(err: unknown): SaveProblem {
  if (err instanceof FieldsInvalidError) {
    const fields: Partial<Record<ResourceField, string>> = {};
    // 한 칸에 오류가 여럿이면 첫 번째만 보여 준다.
    for (const e of err.errors) fields[e.field] ??= fieldErrorText(e.field, e.code);
    return { kind: 'fields', fields };
  }
  if (err instanceof SettingsInvalidError) {
    return { kind: 'settings', message: SETTINGS_ERROR_TEXT[err.error.code], at: err.error.at };
  }
  if (err instanceof VersionConflictError) return { kind: 'conflict', message: CONFLICT_TEXT };
  if (err instanceof SettingsNotFoundError) return { kind: 'gone', message: GONE_TEXT };
  if (err instanceof HttpError) {
    // 5xx(502·504 포함)는 서버가 저장을 마친 뒤 응답만 잃었을 수 있다 — 같은 키를 남겨 재전송 시 응답 재생을 받는다(#75 리뷰).
    // 연결 문제는 아니니 "인터넷 연결" 문구 대신 일반 문구를 쓴다.
    if (err.status >= 500) return { kind: 'failed', message: REJECTED_TEXT };
    // 4xx(세션 만료 등) — 서버가 쓰기를 거절했다. 다음 저장은 새 키.
    return { kind: 'rejected', message: REJECTED_TEXT };
  }
  // 응답을 못 받았다(NetworkError 등) — 서버에 닿았는지 모르니 같은 키로 다시 보낸다.
  return { kind: 'failed', message: FAILED_TEXT };
}

/** 이 문제가 나면 화면 데이터를 다시 불러와야 하는가(충돌·이미 지워짐). */
export const needsReload = (p: SaveProblem) => p.kind === 'conflict' || p.kind === 'gone';
