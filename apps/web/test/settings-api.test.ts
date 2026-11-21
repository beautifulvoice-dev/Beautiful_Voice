// 설정 창구(BEA-166·167) 수용 기준. 화면 없이 창구 동작만 본다 — 화면은 11/21 디자인을 받은 뒤 붙인다.
import { describe, expect, it } from 'vitest';
import {
  createMemorySettingsApi,
  FieldsInvalidError,
  SettingsInvalidError,
  SettingsNotFoundError,
  VersionConflictError,
} from '@/features/settings/api';
import { closureText, fieldErrorText, LAST_STAFF_TEXT, PREP_HELP_TEXT, SETTINGS_ERROR_TEXT } from '@/features/settings/messages';
import { canHideStaff } from '@/features/settings/rules';

const empty = () => createMemorySettingsApi({ businessHours: null, closures: [], menus: [], staff: [] });

describe('영업시간 (BEA-166)', () => {
  it('저장하고 다시 열면 그대로 보인다', async () => {
    const api = empty();
    expect(await api.getBusinessHours()).toBeNull();
    await api.putBusinessHours({ '2': [{ open: '10:00', close: '20:00' }], '7': [{ open: '11:00', close: '24:00' }] });
    expect(await api.getBusinessHours()).toEqual({
      '2': [{ open: '10:00', close: '20:00' }],
      '7': [{ open: '11:00', close: '24:00' }],
    });
  });

  it('여는 시각이 닫는 시각보다 늦으면 저장하지 않고 이유를 준다', async () => {
    const api = empty();
    const err = await api.putBusinessHours({ '3': [{ open: '20:00', close: '10:00' }] }).catch((e) => e);
    expect(err).toBeInstanceOf(SettingsInvalidError);
    expect((err as SettingsInvalidError).error).toEqual({ code: 'OPEN_NOT_BEFORE_CLOSE', at: '3[0]' });
    expect(await api.getBusinessHours()).toBeNull();
  });

  it('비우면(null) 영업시간 검사를 하지 않는 상태로 돌아간다', async () => {
    const api = createMemorySettingsApi();
    await api.putBusinessHours(null);
    expect(await api.getBusinessHours()).toBeNull();
  });
});

describe('휴무·휴가 (BEA-166)', () => {
  it('매주 쉬는 요일과 날짜 구간 휴가를 둘 다 넣고 지울 수 있다', async () => {
    const api = empty();
    const weekly = await api.addClosure({ kind: 'weekly', weekday: 1 });
    await api.addClosure({ kind: 'vacation', startDate: '2026-12-24', endDate: '2026-12-26', note: '연말 휴가' });
    expect((await api.listClosures()).map(closureText)).toEqual(['매주 월요일', '12월 24일 ~ 12월 26일 · 연말 휴가']);

    await api.removeClosure(weekly.id);
    expect(await api.listClosures()).toHaveLength(1);
    await expect(api.removeClosure(weekly.id)).rejects.toBeInstanceOf(SettingsNotFoundError);
  });

  it('시작일이 끝나는 날보다 늦으면 넣지 않는다', async () => {
    const api = empty();
    const err = await api.addClosure({ kind: 'holiday', startDate: '2026-12-26', endDate: '2026-12-24' }).catch((e) => e);
    expect((err as SettingsInvalidError).error.code).toBe('START_AFTER_END');
    expect(await api.listClosures()).toEqual([]);
  });
});

describe('메뉴 (BEA-167)', () => {
  it('시간을 비워도 저장되고, 관리 0분은 거부한다(준비 0분은 허용)', async () => {
    const api = empty();
    const m = await api.addMenu({ name: ' 수분  관리 ' });
    expect(m).toMatchObject({ name: '수분 관리', defaultDurationMin: null, defaultPrepMin: null, active: true, version: 1 });

    const err = await api.addMenu({ name: '등 관리', defaultDurationMin: 0, defaultPrepMin: 0 }).catch((e) => e);
    expect((err as FieldsInvalidError).errors).toEqual([{ field: 'defaultDurationMin', code: 'INVALID_MINUTES' }]);
  });

  it('고치고 숨기면 사용 중 목록에서 빠지고, 숨긴 것까지 보면 남아 있다', async () => {
    const api = empty();
    const m = await api.addMenu({ name: '수분 관리', defaultDurationMin: 60 });
    const edited = await api.updateMenu(m.id, { version: m.version, defaultPrepMin: 10 });
    expect(edited).toMatchObject({ defaultDurationMin: 60, defaultPrepMin: 10, version: 2 });

    await api.updateMenu(m.id, { version: edited.version, active: false });
    expect(await api.listMenus()).toEqual([]);
    expect((await api.listMenus({ includeInactive: true })).map((x) => [x.name, x.active])).toEqual([['수분 관리', false]]);
  });

  it('다른 곳에서 먼저 고쳤으면(옛 version) 저장을 거부한다', async () => {
    const api = empty();
    const m = await api.addMenu({ name: '수분 관리' });
    await api.updateMenu(m.id, { version: 1, name: '수분 관리 A' });
    const err = await api.updateMenu(m.id, { version: 1, name: '수분 관리 B' }).catch((e) => e);
    expect(err).toBeInstanceOf(VersionConflictError);
    expect((err as VersionConflictError).currentVersion).toBe(2);
    expect((await api.listMenus())[0]?.name).toBe('수분 관리 A');
  });
});

describe('담당자 (BEA-167)', () => {
  it('원장 자신도 담당자로 넣고, 이름을 고치고, 숨길 수 있다', async () => {
    const api = empty();
    const s = await api.addStaff({ name: '원장' });
    const renamed = await api.updateStaff(s.id, { version: 1, name: '김원장' });
    await api.updateStaff(s.id, { version: renamed.version, active: false });
    expect(await api.listStaff()).toEqual([]);
    expect((await api.listStaff({ includeInactive: true }))[0]).toMatchObject({ name: '김원장', active: false, version: 3 });
  });

  it('이름이 비면 저장하지 않는다', async () => {
    const err = await empty().addStaff({ name: '   ' }).catch((e) => e);
    expect((err as FieldsInvalidError).errors).toEqual([{ field: 'name', code: 'NAME_REQUIRED' }]);
  });
});

describe('마지막 담당자 (BEA-167)', () => {
  it('사용 중인 담당자가 1명뿐이면 숨길 수 없다 — 예약에는 담당자가 꼭 있어야 한다', async () => {
    const api = empty();
    const a = await api.addStaff({ name: '원장' });
    expect(canHideStaff(await api.listStaff(), a.id)).toBe(false);

    const b = await api.addStaff({ name: '실장' });
    const active = await api.listStaff();
    expect(canHideStaff(active, a.id)).toBe(true);
    expect(canHideStaff(active, b.id)).toBe(true);
  });

  it('이미 숨긴 담당자는 사용 중 인원에 세지 않는다', async () => {
    const api = empty();
    const a = await api.addStaff({ name: '원장' });
    const b = await api.addStaff({ name: '실장' });
    await api.updateStaff(b.id, { version: b.version, active: false });
    expect(canHideStaff(await api.listStaff({ includeInactive: true }), a.id)).toBe(false);
  });
});

describe('문구', () => {
  it('오류 코드 대신 원장이 읽을 문장을 보여 준다', () => {
    expect(SETTINGS_ERROR_TEXT.OPEN_NOT_BEFORE_CLOSE).toBe('여는 시각이 닫는 시각보다 빨라야 해요.');
    expect(fieldErrorText('defaultPrepMin', 'INVALID_MINUTES')).toContain('준비 시간');
    expect(closureText({ id: 'x', kind: 'holiday', startDate: '2026-12-25', endDate: '2026-12-25' })).toBe('12월 25일');
    expect(LAST_STAFF_TEXT).toContain('예약');
    expect(PREP_HELP_TEXT).toContain('시작 전');
  });
});
