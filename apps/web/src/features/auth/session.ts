// 로그인 상태 확인 (U-1·U-2, F-04 계약: packages/contracts/auth.openapi.yaml).
// 세션은 서버가 HttpOnly 쿠키로 들고 있어서, 웹은 /api/auth/session 으로 "누가 어느 매장인지"만 묻는다.
import type { OwnerSessionResponse } from '@bv/contracts';
import { createContext, useContext } from 'react';

export type Session = OwnerSessionResponse;
/** null = 로그인 안 됨. 그 밖의 실패(503·네트워크)는 throw — 로그인 화면이 아니라 "다시 시도"로 보낸다(CAL-8). */
export type SessionLoader = () => Promise<Session | null>;

export const KAKAO_START_URL = '/api/auth/kakao/start';

export async function fetchSession(): Promise<Session | null> {
  const response = await fetch('/api/auth/session', { headers: { Accept: 'application/json' } });
  if (response.status === 401) return null;
  if (!response.ok) throw new Error(`SESSION_${response.status}`);
  return (await response.json()) as Session;
}

/**
 * 개발용: 카카오 키 없이 화면을 볼 때 apps/web/.env.local 에 VITE_DEV_SKIP_LOGIN=1.
 * import.meta.env.DEV 조건이라 배포 빌드에는 들어가지 않는다.
 * ASSUMPTION: 로컬에 카카오 설정이 없는 팀원도 화면 작업을 계속할 수 있어야 한다.
 */
const devSession: SessionLoader = async () => ({ shopId: 'dev-shop' });
const defaultLoader: SessionLoader = import.meta.env.DEV && import.meta.env.VITE_DEV_SKIP_LOGIN === '1' ? devSession : fetchSession;

const SessionLoaderContext = createContext<SessionLoader>(defaultLoader);
/** 테스트에서 로그인 상태를 바꿔 끼울 때 쓴다. */
export const SessionLoaderProvider = SessionLoaderContext.Provider;
export const useSessionLoader = () => useContext(SessionLoaderContext);

const SessionContext = createContext<Session | null>(null);
export const SessionProvider = SessionContext.Provider;

/** 로그인한 원장의 매장. RequireSession 안쪽 화면에서만 쓴다. */
export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error('useSession은 RequireSession 안에서만 쓴다');
  return session;
}
