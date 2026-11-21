// 설정 화면 저장 동작(BEA-166·167): 저장 중 표시, 두 번 누름, 실패 문구, 충돌 다시 불러오기, Idempotency-Key.
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  createMemorySettingsApi,
  FieldsInvalidError,
  SettingsInvalidError,
  SettingsNotFoundError,
  VersionConflictError,
} from '@/features/settings/api';
import { FAILED_TEXT, GONE_TEXT, toSaveProblem } from '@/features/settings/problems';
import { useSaveAction } from '@/features/settings/useSaveAction';

const empty = () => createMemorySettingsApi({ businessHours: null, closures: [], menus: [], staff: [] });

describe('오류 → 화면 문구', () => {
  it('칸 오류는 칸마다 문장으로 바꾼다', () => {
    const p = toSaveProblem(new FieldsInvalidError([{ field: 'defaultPrepMin', code: 'INVALID_MINUTES' }]));
    expect(p).toEqual({ kind: 'fields', fields: { defaultPrepMin: expect.stringContaining('준비 시간') } });
  });

  it('영업시간 오류는 문장과 문제 위치를 준다', () => {
    const p = toSaveProblem(new SettingsInvalidError({ code: 'WINDOWS_OVERLAP', at: '2[1]' }));
    expect(p).toEqual({ kind: 'settings', message: '같은 요일의 영업 시간이 겹쳐요.', at: '2[1]' });
  });

  it('충돌·이미 지워짐·연결 실패를 구분한다', () => {
    expect(toSaveProblem(new VersionConflictError(3)).kind).toBe('conflict');
    expect(toSaveProblem(new SettingsNotFoundError())).toEqual({ kind: 'gone', message: GONE_TEXT });
    expect(toSaveProblem(new TypeError('fetch failed'))).toEqual({ kind: 'failed', message: FAILED_TEXT });
  });
});

describe('저장 동작', () => {
  it('저장하는 동안 saving이고, 그동안 또 누르면 한 번만 저장한다', async () => {
    let finish!: () => void;
    const save = vi.fn(() => new Promise<string>((r) => (finish = () => r('ok'))));
    const { result } = renderHook(() => useSaveAction(() => {}));

    let first!: Promise<string | undefined>;
    act(() => {
      first = result.current.run(save);
    });
    expect(result.current.saving).toBe(true);
    await act(async () => {
      expect(await result.current.run(save)).toBeUndefined();
    });
    expect(save).toHaveBeenCalledTimes(1);

    await act(async () => {
      finish();
      expect(await first).toBe('ok');
    });
    expect(result.current.saving).toBe(false);
    expect(result.current.problem).toBeNull();
  });

  it('다른 곳에서 먼저 고쳤으면 문구를 보여 주고 화면 데이터를 다시 불러온다', async () => {
    const api = empty();
    const m = await api.addMenu({ name: '수분 관리' });
    await api.updateMenu(m.id, { version: 1, name: '수분 관리 A' });
    const reload = vi.fn();
    const { result } = renderHook(() => useSaveAction(reload));

    await act(async () => {
      await result.current.run((key) => api.updateMenu(m.id, { version: 1, name: '수분 관리 B' }, { idempotencyKey: key }));
    });
    expect(result.current.problem?.kind).toBe('conflict');
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('입력 오류는 다시 불러오지 않고 칸 문구만 준다', async () => {
    const reload = vi.fn();
    const { result } = renderHook(() => useSaveAction(reload));
    await act(async () => {
      await result.current.run((key) => empty().addStaff({ name: ' ' }, { idempotencyKey: key }));
    });
    expect(result.current.problem).toEqual({ kind: 'fields', fields: { name: '이름을 입력해 주세요.' } });
    expect(reload).not.toHaveBeenCalled();
  });
});

describe('Idempotency-Key', () => {
  it('연결이 끊겨 다시 시도하면 같은 키를 보내서 메뉴가 두 번 생기지 않는다', async () => {
    const api = empty();
    let n = 0;
    const { result } = renderHook(() => useSaveAction(() => {}, () => `key-${++n}`));
    const keys: string[] = [];
    let lostResponse = true;

    // 첫 시도: 서버는 저장했지만 응답이 끊겼다.
    const save = async (key: string) => {
      keys.push(key);
      const created = await api.addMenu({ name: '수분 관리' }, { idempotencyKey: key });
      if (lostResponse) throw new TypeError('network');
      return created;
    };
    await act(async () => {
      await result.current.run(save);
    });
    expect(result.current.problem?.kind).toBe('failed');

    lostResponse = false;
    await act(async () => {
      await result.current.run(save);
    });
    expect(keys).toEqual(['key-1', 'key-1']);
    expect(await api.listMenus()).toHaveLength(1);

    // 성공한 뒤 다음 저장은 새 키
    await act(async () => {
      await result.current.run(save);
    });
    expect(keys[2]).toBe('key-2');
  });

  it('실패 뒤 입력을 고치면(clear) 새 키로 보낸다', async () => {
    let n = 0;
    const { result } = renderHook(() => useSaveAction(() => {}, () => `key-${++n}`));
    const keys: string[] = [];
    const fail = async (key: string) => {
      keys.push(key);
      throw new TypeError('network');
    };
    await act(async () => {
      await result.current.run(fail);
    });
    act(() => result.current.clear());
    expect(result.current.problem).toBeNull();
    await act(async () => {
      await result.current.run(fail);
    });
    expect(keys).toEqual(['key-1', 'key-2']);
  });
});
