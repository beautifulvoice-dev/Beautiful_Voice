// 설정 화면의 "저장" 버튼 하나가 쓰는 동작: 저장 중 표시, 두 번 누름 막기, 실패 문구, 충돌이면 다시 불러오기.
import { useCallback, useRef, useState } from 'react';
import { needsReload, toSaveProblem, type SaveProblem } from './problems';

export interface SaveAction {
  saving: boolean;
  problem: SaveProblem | null;
  /** 저장한다. 성공하면 결과를, 실패하면 undefined를 돌려준다(문구는 problem에 담긴다). */
  run<T>(save: (idempotencyKey: string) => Promise<T>): Promise<T | undefined>;
  /** 입력을 고치기 시작할 때 부른다. 문구를 닫고, 내용이 바뀌었으니 다음 저장은 새 키를 쓴다. */
  clear(): void;
}

const randomKey = () => crypto.randomUUID();

/**
 * @param reload 충돌·이미 지워짐일 때 화면 데이터를 다시 불러오는 함수(useLoad의 reload).
 *
 * Idempotency-Key(절대 규칙 6): 한 번의 저장 시도에 키 하나. 연결 실패 뒤 "다시 시도"는 같은 키를 다시 보내서
 * 서버가 이미 저장했더라도 두 번 생기지 않게 한다. 성공·서버 거절로 끝나거나 입력을 고치면(clear) 새 키를 쓴다.
 */
export function useSaveAction(reload: () => void, newKey: () => string = randomKey): SaveAction {
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<SaveProblem | null>(null);
  const busy = useRef(false);
  const pendingKey = useRef<string | null>(null);

  const run = useCallback(
    async <T>(save: (idempotencyKey: string) => Promise<T>): Promise<T | undefined> => {
      if (busy.current) return undefined; // 저장 중에 또 누르면 무시
      busy.current = true;
      setSaving(true);
      setProblem(null);
      const key = (pendingKey.current ??= newKey());
      try {
        const result = await save(key);
        pendingKey.current = null;
        return result;
      } catch (err) {
        const p = toSaveProblem(err);
        if (p.kind !== 'failed') pendingKey.current = null; // 서버가 답을 줬으니 재전송할 일이 없다
        setProblem(p);
        if (needsReload(p)) reload();
        return undefined;
      } finally {
        busy.current = false;
        setSaving(false);
      }
    },
    [reload, newKey],
  );

  const clear = useCallback(() => {
    pendingKey.current = null;
    setProblem(null);
  }, []);
  return { saving, problem, run, clear };
}
