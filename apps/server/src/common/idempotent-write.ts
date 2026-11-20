import type { PoolClient } from 'pg';
import type { DatabaseService } from '../database.service';
import { ApiError } from './api-error';
import { IDEMPOTENCY_KEY_HEADER, IDEMPOTENT_REPLAYED_HEADER, parseIdempotencyKey, requestFingerprint, runIdempotent } from './idempotency';

// express 타입 의존성을 늘리지 않으려고 필요한 칸만 적는다.
export interface WriteRequest {
  method: string;
  url: string;
  originalUrl?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
}
export interface WriteResponse {
  status(code: number): unknown;
  setHeader(name: string, value: string): unknown;
}

/**
 * CRM 쓰기 한 번 = 매장 트랜잭션 하나. 그 안에서 Idempotency-Key를 먼저 잡고(F-05) 업무 쓰기를 한다.
 * - 키는 필수(#42 계약). 없으면 400 — 키 없이 재전송하면 추가 요청이 두 번 저장된다.
 * - 같은 키·같은 요청이 다시 오면 처음 응답을 그대로 돌려주고 `Idempotent-Replayed: true`를 붙인다.
 *   "같은 요청"은 메서드 + 경로 + **쿼리** + 본문이다. 쿼리도 넣어야 `DELETE …?version=1` 뒤에 같은 키로
 *   `?version=2`를 보냈을 때 이전 204를 재생하지 않고 422로 거부한다(#42 리뷰).
 * - handler가 예외를 던지면 트랜잭션이 롤백되어 키도 사라진다 → 고쳐서 같은 키로 다시 보낼 수 있다.
 */
export async function idempotentWrite<T>(
  database: DatabaseService,
  shopId: string,
  request: WriteRequest,
  response: WriteResponse,
  status: number,
  handler: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const key = parseIdempotencyKey(request.headers[IDEMPOTENCY_KEY_HEADER]);
  if (key === null) throw new ApiError(400, 'INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key header is required');
  const fingerprint = requestFingerprint(request.method, requestTarget(request.originalUrl ?? request.url), request.body ?? null);
  const result = await database.withShop(shopId, (client) =>
    runIdempotent(client, { key, fingerprint }, async () => ({ status, body: await handler(client) })));
  response.status(result.status);
  if (result.replayed) response.setHeader(IDEMPOTENT_REPLAYED_HEADER, 'true');
  return result.body;
}

/** 경로 + 쿼리(이름 순으로 정렬해 `?b=1&a=2`와 `?a=2&b=1`을 같게). 쿼리가 없으면 경로만. */
export function requestTarget(url: string): string {
  const at = url.indexOf('?');
  if (at < 0) return url;
  const params = [...new URLSearchParams(url.slice(at + 1))].sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0));
  const query = new URLSearchParams(params).toString();
  return query ? `${url.slice(0, at)}?${query}` : url.slice(0, at);
}
