// 웹 공통 HTTP 요청부(설계 05 D1). 같은 출처 상대 경로, 경로·쿼리 인코딩, JSON·빈 204, 취소 신호, 오류 {code,message,details} 해석.
// 세션 쿠키(HttpOnly)는 브라우저가 붙인다. 화면 문구는 고르지 않는다 — 기능 어댑터·화면이 code를 보고 고른다.
// 요청·응답 본문(고객 이름·검색어 등)을 로그에 남기지 않는다(절대 규칙 8).

/** 서버가 답한 실패(4xx·5xx). code는 계약의 오류 코드, 본문을 못 읽으면 'UNKNOWN'. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(code);
    this.name = 'HttpError';
  }
}

/** 응답을 받지 못함(연결 끊김 등). 쓰기라면 서버에 닿았는지 알 수 없다 → 같은 요청·같은 키로만 다시 보낸다(설계 05 D5). */
export class NetworkError extends Error {
  constructor() {
    super('NETWORK');
    this.name = 'NetworkError';
  }
}

export type Query = Record<string, string | number | boolean | null | undefined>;

export interface RequestOptions {
  query?: Query;
  body?: unknown;
  /** 쓰기 요청의 Idempotency-Key(절대 규칙 6). */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

export interface Http {
  get<T>(path: string, options?: Omit<RequestOptions, 'body' | 'idempotencyKey'>): Promise<T>;
  send<T>(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, options?: RequestOptions): Promise<T>;
}

/** '/api/shops/{shopId}/…' — 칸마다 인코딩한다. */
export function shopPath(shopId: string, ...segments: string[]): string {
  return ['/api/shops', shopId, ...segments].map((s, i) => (i === 0 ? s : encodeURIComponent(s))).join('/');
}

function withQuery(path: string, query: Query | undefined): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

export function createHttp(fetcher: Fetcher = (input, init) => fetch(input, init)): Http {
  async function request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
    let response: Response;
    try {
      response = await fetcher(withQuery(path, options.query), {
        method,
        headers,
        credentials: 'same-origin',
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: options.signal,
      });
    } catch (err) {
      if ((err as { name?: unknown } | null)?.name === 'AbortError') throw err;
      throw new NetworkError();
    }
    if (response.status === 204) return undefined as T;
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { code?: unknown; details?: unknown } | null;
      const code = typeof body?.code === 'string' ? body.code : 'UNKNOWN';
      const details = body?.details && typeof body.details === 'object' ? (body.details as Record<string, unknown>) : {};
      throw new HttpError(response.status, code, details);
    }
    try {
      return (await response.json()) as T;
    } catch (err) {
      if ((err as { name?: unknown } | null)?.name === 'AbortError') throw err;
      // 성공 헤더는 왔지만 본문을 끝까지 못 받음 — 서버는 저장했을 수 있다. 결과 모름으로 보고
      // 같은 경로·본문·키로 다시 보내게 한다(설계 05 D5: 서버가 처음 응답을 재생한다).
      throw new NetworkError();
    }
  }
  return {
    get: (path, options) => request('GET', path, options),
    send: (method, path, options) => request(method, path, options),
  };
}

export const http = createHttp();
