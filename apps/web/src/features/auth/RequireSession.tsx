// 로그인한 원장만 매장 화면을 본다. 안 했으면 /login, 확인 자체가 실패하면 다시 시도(CAL-8).
import { useState, type ReactNode } from 'react';
import { Navigate } from 'react-router';
import { ErrorState } from '@/components/states/DataState';
import { useLoad } from '@/lib/useLoad';
import { SessionProvider, useSessionLoader } from './session';

export function RequireSession({ children }: { children: ReactNode }) {
  const { state, reload } = useLoad(useSessionLoader());

  if (state.status === 'loading') return <p className="py-16 text-center text-sm text-muted-foreground">로그인 확인 중…</p>;
  if (state.status === 'error') return <ErrorState onRetry={reload} />;
  if (!state.data) return <Navigate to="/login" replace />;
  if (state.data.consent) {
    return <OwnerConsent key={state.data.consent.version} consent={state.data.consent} onAccepted={reload} />;
  }
  return (
    <SessionProvider value={state.data}>
      {children}
    </SessionProvider>
  );
}

function OwnerConsent({ consent, onAccepted }: {
  consent: { version: string; text: string };
  onAccepted: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  async function accept() {
    setPending(true);
    setFailed(false);
    try {
      const response = await fetch('/api/auth/consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: consent.version }),
      });
      if (!response.ok && response.status !== 409 && response.status !== 401) throw new Error();
      onAccepted();
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="mx-auto max-w-md space-y-5 px-5 py-12">
      <h1 className="text-2xl font-bold">이용 동의</h1>
      <p className="whitespace-pre-wrap">{consent.text}</p>
      {failed && <p role="alert">동의를 저장하지 못했어요. 다시 시도해 주세요.</p>}
      <button type="button" disabled={pending} onClick={() => void accept()}
        className="w-full rounded-xl bg-brand px-4 py-3 font-semibold text-white disabled:opacity-50">
        {pending ? '저장 중…' : '동의하고 계속하기'}
      </button>
    </main>
  );
}
