import type { Page } from '@bv/contracts';
import { ApiError } from './api-error';

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

// 커서는 마지막 항목의 (정렬값, id). 같은 정렬값이 여러 개여도 id로 순서가 고정된다(keyset).
// 쿼리 예: WHERE (created_at, id) > ($v, $id) ORDER BY created_at, id LIMIT limit + 1
export interface CursorPosition {
  v: string | number;
  id: string;
}

export function parseLimit(raw: string | string[] | undefined): number {
  if (raw === undefined) return DEFAULT_LIMIT;
  const limit = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!(limit >= 1 && limit <= MAX_LIMIT)) {
    throw new ApiError(400, 'INVALID_LIMIT', `limit must be an integer from 1 to ${MAX_LIMIT}`);
  }
  return limit;
}

export function encodeCursor(position: CursorPosition): string {
  return Buffer.from(JSON.stringify({ v: position.v, id: position.id })).toString('base64url');
}

export function decodeCursor(raw: string | string[] | undefined): CursorPosition | null {
  if (raw === undefined) return null;
  const invalid = () => new ApiError(400, 'INVALID_CURSOR', 'cursor is invalid');
  if (typeof raw !== 'string' || !/^[A-Za-z0-9_-]+$/.test(raw)) throw invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  const { v, id } = (parsed ?? {}) as Record<string, unknown>;
  if (Array.isArray(parsed) || (typeof v !== 'string' && typeof v !== 'number') || typeof id !== 'string' || id === '') {
    throw invalid();
  }
  return { v, id };
}

// rows는 limit + 1개까지 조회한 결과. 하나 더 있으면 다음 페이지가 있다.
export function toPage<T>(rows: readonly T[], limit: number, positionOf: (row: T) => CursorPosition): Page<T> {
  const items = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  return { items, nextCursor: hasMore ? encodeCursor(positionOf(items[items.length - 1])) : null };
}
