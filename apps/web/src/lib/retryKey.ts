// 저장 의도 하나에 Idempotency-Key 하나(설계 05 저장 키·D5).
// 같은 내용을 다시 보내면(응답을 못 받은 뒤 다시 시도) 같은 키, 내용이 바뀌면 새 키. 성공·명확한 거절로 끝나면 settle()로 비운다.
import { useRef } from 'react';
import { randomKey } from '@/features/settings/useSaveAction';

export interface RetryKey {
  /** 보낼 요청(메서드·경로·본문)을 문자열로 — 같으면 같은 키. */
  keyFor(request: string): string;
  /** 결과가 확정됐다(성공·서버 거절). 다음 저장은 새 키. */
  settle(): void;
}

export function createRetryKey(newKey: () => string = randomKey): RetryKey {
  let last: { request: string; key: string } | null = null;
  return {
    keyFor(request) {
      if (last?.request !== request) last = { request, key: newKey() };
      return last.key;
    },
    settle() {
      last = null;
    },
  };
}

export function useRetryKey(): RetryKey {
  const ref = useRef<RetryKey | null>(null);
  return (ref.current ??= createRetryKey());
}
