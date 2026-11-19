import { timingSafeEqual } from 'node:crypto';
import type { DatabaseService } from './database.service';

export interface KakaoLoginConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export class KakaoLoginError extends Error {
  constructor(readonly reason: 'invalid_callback' | 'rejected' | 'unavailable') {
    super(reason);
  }
}

export function kakaoAuthorizationUrl(config: KakaoLoginConfig, state: string): URL {
  const url = new URL('https://kauth.kakao.com/oauth/authorize');
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    state,
  }).toString();
  return url;
}

export async function authenticateKakaoOwner(
  config: KakaoLoginConfig,
  callback: { code: string; state: string },
  expectedState: string,
  database: Pick<DatabaseService, 'findKakaoOwner'>,
  request: typeof fetch = fetch,
): Promise<{ userId: string; shopId: string } | null> {
  const kakaoId = await verifyKakaoCallback(config, callback, expectedState, request);
  return database.findKakaoOwner(kakaoId);
}

// The callback handler must provide the state stored for this browser and consume it once.
export async function verifyKakaoCallback(
  config: KakaoLoginConfig,
  callback: { code: string; state: string },
  expectedState: string,
  request: typeof fetch = fetch,
): Promise<string> {
  const actual = Buffer.from(callback.state);
  const expected = Buffer.from(expectedState);
  if (!callback.code || !expected.length || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new KakaoLoginError('invalid_callback');
  }

  const token = await kakaoJson(request, 'https://kauth.kakao.com/oauth/token', {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      code: callback.code,
    }),
  });
  const accessToken = token.access_token;
  if (typeof accessToken !== 'string' || !accessToken) throw new KakaoLoginError('unavailable');

  const profile = await kakaoJson(request, 'https://kapi.kakao.com/v2/user/me', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const id = profile.id;
  // Refuse IDs that JSON number parsing cannot represent exactly.
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) throw new KakaoLoginError('unavailable');
  return String(id);
}

async function kakaoJson(
  request: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<Record<string, unknown>> {
  try {
    const response = await request(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(5000) });
    if (!response.ok) {
      throw new KakaoLoginError([400, 401, 403].includes(response.status) ? 'rejected' : 'unavailable');
    }
    const value: unknown = await response.json();
    if (typeof value !== 'object' || !value || Array.isArray(value)) throw new KakaoLoginError('unavailable');
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof KakaoLoginError) throw error;
    throw new KakaoLoginError('unavailable');
  }
}
