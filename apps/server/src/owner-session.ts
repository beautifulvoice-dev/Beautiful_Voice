import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { ApiError } from './common/api-error';
import type { KakaoLoginConfig } from './kakao-login';

export const SESSION_COOKIE = 'bv_session';
export const APP_SESSION_PURPOSE = 'owner-app-session';
export const STATE_COOKIE = 'bv_oauth_state';
export const SESSION_SECONDS = 30 * 24 * 60 * 60;
export const STATE_SECONDS = 5 * 60;
export const CALLBACK_PATH = '/api/auth/kakao/callback';

export function ownerConsent() {
  const { BV_OWNER_CONSENT_VERSION, BV_OWNER_CONSENT_TEXT } = process.env;
  if (process.env.NODE_ENV !== 'production' && !BV_OWNER_CONSENT_VERSION && !BV_OWNER_CONSENT_TEXT) return null;
  if (!BV_OWNER_CONSENT_VERSION?.trim() || !BV_OWNER_CONSENT_TEXT?.trim()) {
    throw new ApiError(503, 'AUTH_UNAVAILABLE', '로그인을 사용할 수 없습니다.');
  }
  const text = BV_OWNER_CONSENT_TEXT;
  const version = createHash('sha256').update(JSON.stringify([BV_OWNER_CONSENT_VERSION, text])).digest('hex');
  return { version, text };
}

export function authConfig(): (KakaoLoginConfig & { key: Buffer; secure: boolean }) | null {
  const { KAKAO_CLIENT_ID, KAKAO_CLIENT_SECRET, KAKAO_REDIRECT_URI, BV_SESSION_SECRET } = process.env;
  if (!KAKAO_CLIENT_ID || !KAKAO_CLIENT_SECRET || !KAKAO_REDIRECT_URI || !/^[0-9a-f]{64}$/i.test(BV_SESSION_SECRET ?? '')) {
    return null;
  }
  try {
    const url = new URL(KAKAO_REDIRECT_URI);
    const secure = url.protocol === 'https:';
    const local = process.env.NODE_ENV !== 'production' && url.protocol === 'http:'
      && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if ((!secure && !local) || url.pathname !== CALLBACK_PATH || url.search || url.hash || url.username || url.password) {
      return null;
    }
    return {
      clientId: KAKAO_CLIENT_ID, clientSecret: KAKAO_CLIENT_SECRET,
      redirectUri: KAKAO_REDIRECT_URI, key: Buffer.from(BV_SESSION_SECRET!, 'hex'), secure,
    };
  } catch {
    return null;
  }
}

export function readCookie(header: string | undefined, name: string): string {
  const matches = (header ?? '').split(';').map((part) => part.trim()).filter((part) => part.startsWith(name + '='));
  return matches.length === 1 ? matches[0].slice(name.length + 1) : '';
}

export function makeCookie(name: string, value: string, maxAge: number, path: string, secure: boolean): string {
  return `${name}=${value}; Max-Age=${maxAge}; Path=${path}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

export function signCookie(key: Buffer, purpose: string, value: string, seconds: number): string {
  const expires = Math.floor(Date.now() / 1000) + seconds;
  const body = Buffer.from(JSON.stringify({ value, expires })).toString('base64url');
  return body + '.' + mac(key, purpose, body).toString('base64url');
}

export function verifyCookie(key: Buffer, purpose: string, token: string): string | null {
  if (token.length > 1024 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const [body, signature] = token.split('.');
  const actual = Buffer.from(signature, 'base64url');
  if (actual.toString('base64url') !== signature || !timingSafeEqual(actual, mac(key, purpose, body))) return null;
  try {
    const { value, expires } = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return typeof value === 'string' && Number.isInteger(expires)
      && expires > Math.floor(Date.now() / 1000) ? value : null;
  } catch {
    return null;
  }
}

function mac(key: Buffer, purpose: string, body: string): Buffer {
  return createHmac('sha256', key).update(purpose + ':' + body).digest();
}
