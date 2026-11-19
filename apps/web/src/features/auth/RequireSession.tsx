// 로그인한 원장만 매장 화면을 본다. 안 했으면 /login, 확인 자체가 실패하면 다시 시도(CAL-8).
import type { ReactNode } from 'react';
import { Navigate } from 'react-router';
import { ErrorState } from '@/components/states/DataState';
import { useLoad } from '@/lib/useLoad';
import { SessionProvider, useSessionLoader } from './session';

export function RequireSession({ children }: { children: ReactNode }) {
  const { state, reload } = useLoad(useSessionLoader());

  if (state.status === 'loading') return <p className="py-16 text-center text-sm text-muted-foreground">로그인 확인 중…</p>;
  if (state.status === 'error') return <ErrorState onRetry={reload} />;
  if (!state.data) return <Navigate to="/login" replace />;
  return (
    <SessionProvider value={state.data}>
      {children}
    </SessionProvider>
  );
}
