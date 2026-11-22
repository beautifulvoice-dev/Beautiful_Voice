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
  /** 서버가 답했지만 위 경우가 아님(500·세션 만료 등) — 이 키는 끝났으니 다음 저장은 새 키를 쓴다(#72 리뷰). */
  | { kind: 'rejected'; message: string }
  /** 연결 끊김 등 — 같은 내용으로 다시 시도할 수 있다. */
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
  // 서버가 답을 줬다 — 연결 문제가 아니니 "인터넷 연결" 문구를 쓰지 않는다.
  if (err instanceof HttpError) return { kind: 'rejected', message: REJECTED_TEXT };
  // 응답을 못 받았다(NetworkError 등) — 서버에 닿았는지 모르니 같은 키로 다시 보낸다.
  return { kind: 'failed', message: FAILED_TEXT };
}

/** 이 문제가 나면 화면 데이터를 다시 불러와야 하는가(충돌·이미 지워짐). */
export const needsReload = (p: SaveProblem) => p.kind === 'conflict' || p.kind === 'gone';
