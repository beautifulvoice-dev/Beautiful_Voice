// 화면 데이터 불러오기: 로딩 / 실패 / 성공을 나눠 돌려준다. 실패는 ErrorState, 빈 결과는 EmptyState로(CAL-8).
import { useCallback, useEffect, useState } from 'react';

export type LoadState<T> = { status: 'loading' } | { status: 'error' } | { status: 'ok'; data: T };

/** load가 바뀌면 다시 불러온다 — 호출 측은 useCallback으로 감싸서 넘긴다. */
export function useLoad<T>(load: () => Promise<T>): { state: LoadState<T>; reload: () => void } {
  const [state, setState] = useState<LoadState<T>>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    setState({ status: 'loading' });
    load().then(
      (data) => alive && setState({ status: 'ok', data }),
      () => alive && setState({ status: 'error' }),
    );
    return () => {
      alive = false;
    };
  }, [load, attempt]);

  const reload = useCallback(() => setAttempt((a) => a + 1), []);
  return { state, reload };
}
