import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { ApiError } from './api-error';

export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
export const IDEMPOTENT_REPLAYED_HEADER = 'Idempotent-Replayed';
const MAX_KEY_LENGTH = 255;

// 헤더 값 검사. 없으면 null — 쓰기 API는 키를 "허용"한다(02 §4).
// ASSUMPTION: 키를 필수로 할지는 엔드포인트별로 정한다(예: 기기 업로드는 필수).
export function parseIdempotencyKey(raw: string | string[] | undefined): string | null {
  if (raw === undefined) return null;
  if (Array.isArray(raw) || raw.trim() === '' || raw.length > MAX_KEY_LENGTH || !/^[\x21-\x7e]+$/.test(raw)) {
    throw new ApiError(400, 'INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key must be 1-255 visible ASCII characters');
  }
  return raw;
}

// 같은 키가 "같은 요청"인지 가르는 지문. 본문 객체의 키 순서는 무시한다.
export function requestFingerprint(method: string, path: string, body: unknown): string {
  return createHash('sha256')
    .update(`${method.toUpperCase()} ${path}\n${canonicalJson(body)}`)
    .digest('hex');
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export interface IdempotentResponse<T> {
  status: number;
  body: T;
}

export interface IdempotentResult<T> extends IdempotentResponse<T> {
  replayed: boolean;
}

// 업무 쓰기와 같은 트랜잭션(DatabaseService.withShop) 안에서 호출한다.
// - 처음 온 키: 행을 선점하고 handler를 실행해 응답을 저장한다.
// - 같은 키가 동시에 오면 기본 키 잠금 때문에 먼저 온 트랜잭션이 끝날 때까지 기다린 뒤 저장된 응답을 돌려준다.
// - handler가 실패해 트랜잭션이 롤백되면 키도 사라지므로 다시 시도할 수 있다.
// handler는 성공 응답만 돌려주고, 실패는 예외로 던진다(오류 응답은 저장하지 않는다).
export async function runIdempotent<T>(
  client: PoolClient | { query: PoolClient['query'] },
  request: { key: string; fingerprint: string },
  handler: () => Promise<IdempotentResponse<T>>,
): Promise<IdempotentResult<T>> {
  const claimed = await client.query(
    `INSERT INTO crm.idempotency_key (shop_id, key, request_hash)
     VALUES (nullif(current_setting('app.shop_id', true), '')::uuid, $1, $2)
     ON CONFLICT (shop_id, key) DO NOTHING`,
    [request.key, request.fingerprint],
  );

  if (claimed.rowCount === 1) {
    const response = await handler();
    await client.query(
      `UPDATE crm.idempotency_key SET response_status = $2, response_body = $3
       WHERE shop_id = nullif(current_setting('app.shop_id', true), '')::uuid AND key = $1`,
      [request.key, response.status, JSON.stringify(response.body)],
    );
    return { ...response, replayed: false };
  }

  const { rows: [stored] } = await client.query<{
    request_hash: string; response_status: number; response_body: T;
  }>(
    `SELECT request_hash, response_status, response_body FROM crm.idempotency_key
     WHERE shop_id = nullif(current_setting('app.shop_id', true), '')::uuid AND key = $1`,
    [request.key],
  );
  if (!stored || stored.request_hash !== request.fingerprint) {
    throw new ApiError(422, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different request');
  }
  return { status: stored.response_status, body: stored.response_body, replayed: true };
}
