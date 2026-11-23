// BEA-167 수용 기준(메뉴): 등록·수정·숨김이 되고 기본 시간이 저장된다 · 잘못된 값은 이유와 함께 거부 · 동시 수정은 안내. 데이터는 합성(절대 규칙 8).
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { describe, expect, it } from 'vitest';
import { SessionLoaderProvider } from '@/features/auth/session';
import { createMemorySettingsApi, SettingsApiProvider, type SettingsApi } from '@/features/settings/api';
import { menuTimeText } from '@/features/settings/menus';
import { MENU_CONFLICT_TEXT } from '@/pages/settings/MenusPage';
import { routes } from '@/routes';

function renderAt(path: string, api: SettingsApi = createMemorySettingsApi()) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <SessionLoaderProvider value={async () => ({ shopId: 'shop-1' })}>
      <SettingsApiProvider value={api}>
        <RouterProvider router={router} />
      </SettingsApiProvider>
    </SessionLoaderProvider>,
  );
  return router;
}

const menuList = () => screen.findByRole('list', { name: '메뉴 목록' });
const rows = async () => within(await menuList()).getAllByRole('listitem').map((li) => li.textContent);
const sheet = () => screen.findByRole('dialog');
/** 시간 고르기(SEED QuantityPicker): "정하기" → 처음 값, 버튼 한 번 = 5분. */
const btn = (dialog: HTMLElement, name: string) => within(dialog).getByRole('button', { name });
const minutes = (dialog: HTMLElement, label: string) => within(within(dialog).getByRole('group', { name: label })).getByLabelText(`${label} 분`);
async function press(dialog: HTMLElement, name: string, times = 1) {
  for (let i = 0; i < times; i++) await userEvent.click(btn(dialog, name));
}

async function save(dialog: HTMLElement) {
  await userEvent.click(within(dialog).getByRole('button', { name: '저장' }));
}
const closed = () => waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

describe('메뉴 문구·값', () => {
  it('목록 한 줄 시간 설명', () => {
    expect(menuTimeText({ defaultDurationMin: 60, defaultPrepMin: 10 })).toBe('관리 60분 · 준비 10분');
    expect(menuTimeText({ defaultDurationMin: 50, defaultPrepMin: null })).toBe('관리 50분');
    expect(menuTimeText({ defaultDurationMin: null, defaultPrepMin: 0 })).toBe('준비 0분');
    expect(menuTimeText({ defaultDurationMin: null, defaultPrepMin: null })).toBe('시간 안 정함');
  });


});

describe('메뉴 화면', () => {
  it('사용 중인 메뉴와 시간을 보이고, 숨긴 메뉴는 접어 둔다', async () => {
    renderAt('/settings/menus');
    expect(await rows()).toEqual(['수분 관리관리 60분 · 준비 10분›', '등 관리관리 90분 · 준비 10분›']);
    expect(screen.getByText('숨긴 메뉴 1개')).toBeInTheDocument();
  });

  it('시간을 정하고 ＋/－로 맞춰 메뉴를 추가한다(디자인 부품 QuantityPicker)', async () => {
    const api = createMemorySettingsApi();
    renderAt('/settings/menus', api);
    await userEvent.click(await screen.findByRole('button', { name: '메뉴 추가' }));
    const d = await sheet();
    await userEvent.type(within(d).getByLabelText('이름'), '얼굴 관리');
    await press(d, '관리 시간 정하기'); // 60분
    await press(d, '준비 시간 정하기'); // 10분
    await press(d, '준비 시간 5분 늘리기', 2); // 20분
    expect(minutes(d, '준비 시간')).toHaveValue('20');
    await save(d);
    await closed();
    expect(await rows()).toContain('얼굴 관리관리 60분 · 준비 20분›');
    expect((await api.listMenus()).at(-1)).toMatchObject({ name: '얼굴 관리', defaultDurationMin: 60, defaultPrepMin: 20 });
  });

  it.each([
    ['63', '7'],
    ['1200', '1007'],
  ])('관리 %s분·준비 %s분을 잘리지 않고 직접 입력해 저장한다(#78 리뷰)', async (duration, prep) => {
    const api = createMemorySettingsApi();
    renderAt('/settings/menus', api);
    await userEvent.click(await screen.findByRole('button', { name: /수분 관리/ }));
    const d = await sheet();
    await userEvent.clear(minutes(d, '준비 시간'));
    await userEvent.type(minutes(d, '준비 시간'), prep);
    await userEvent.clear(minutes(d, '관리 시간'));
    await userEvent.type(minutes(d, '관리 시간'), duration);
    await save(d);
    await closed();
    expect((await api.listMenus()).find((m) => m.name === '수분 관리')).toMatchObject({
      defaultDurationMin: Number(duration),
      defaultPrepMin: Number(prep),
    });
  });

  it('시간을 비워도 저장된다', async () => {
    renderAt('/settings/menus');
    await userEvent.click(await screen.findByRole('button', { name: '메뉴 추가' }));
    const d = await sheet();
    await userEvent.type(within(d).getByLabelText('이름'), '상담');
    await save(d);
    await closed();
    expect(await rows()).toContain('상담시간 안 정함›');
  });

  it('누르면 고칠 수 있고, 고친 시간이 저장된다', async () => {
    const api = createMemorySettingsApi();
    renderAt('/settings/menus', api);
    await userEvent.click(await screen.findByRole('button', { name: /수분 관리/ }));
    const d = await sheet();
    expect(minutes(d, '관리 시간')).toHaveValue('60');
    await press(d, '관리 시간 5분 늘리기', 3); // 75분
    await save(d);
    await closed();
    expect((await api.listMenus()).find((m) => m.name === '수분 관리')).toMatchObject({ defaultDurationMin: 75, version: 2 });
  });

  it('이름이 비면 이유를 보이고 저장하지 않는다. 관리 시간은 5분 밑으로 내려가지 않는다', async () => {
    const api = createMemorySettingsApi();
    renderAt('/settings/menus', api);
    await userEvent.click(await screen.findByRole('button', { name: '메뉴 추가' }));
    const d = await sheet();
    await press(d, '관리 시간 정하기');
    await press(d, '관리 시간 5분 줄이기', 11); // 60 → 5에서 멈춤
    expect(minutes(d, '관리 시간')).toHaveValue('5');
    expect(btn(d, '관리 시간 5분 줄이기')).toBeDisabled();
    await save(d);
    expect(await within(d).findByText('이름을 입력해 주세요.')).toBeInTheDocument();
    expect(await api.listMenus({ includeInactive: true })).toHaveLength(3);
  });

  it('정한 시간을 비우면 "시간 안 정함"으로 저장된다', async () => {
    const api = createMemorySettingsApi();
    renderAt('/settings/menus', api);
    await userEvent.click(await screen.findByRole('button', { name: /등 관리/ }));
    const d = await sheet();
    await press(d, '준비 시간 비우기');
    expect(within(within(d).getByRole('group', { name: '준비 시간' })).getByText('정하지 않음')).toBeInTheDocument();
    await save(d);
    await closed();
    expect((await api.listMenus()).find((m) => m.name === '등 관리')).toMatchObject({ defaultDurationMin: 90, defaultPrepMin: null });
  });

  it('숨기면 숨긴 메뉴로 가고, 다시 보이기로 되돌린다', async () => {
    const api = createMemorySettingsApi();
    renderAt('/settings/menus', api);
    await userEvent.click(await screen.findByRole('button', { name: /등 관리/ }));
    await userEvent.click(within(await sheet()).getByRole('button', { name: '메뉴 숨기기' }));
    await closed();
    await waitFor(async () => expect(await rows()).toEqual(['수분 관리관리 60분 · 준비 10분›']));
    expect(screen.getByText('숨긴 메뉴 2개')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '등 관리 다시 보이기' }));
    await waitFor(async () => expect(await rows()).toHaveLength(2));
    expect((await api.listMenus()).map((m) => m.name)).toEqual(['수분 관리', '등 관리']);
  });

  it('추가한 뒤 다시 "메뉴 추가"를 열면 칸이 비어 있다(#61 리뷰)', async () => {
    renderAt('/settings/menus');
    await userEvent.click(await screen.findByRole('button', { name: '메뉴 추가' }));
    let d = await sheet();
    await userEvent.type(within(d).getByLabelText('이름'), '얼굴 관리');
    await press(d, '관리 시간 정하기');
    await save(d);
    await closed();
    await userEvent.click(await screen.findByRole('button', { name: '메뉴 추가' }));
    d = await sheet();
    expect(within(d).getByLabelText('이름')).toHaveValue('');
    expect(within(within(d).getByRole('group', { name: '관리 시간' })).getByText('정하지 않음')).toBeInTheDocument();
  });

  it('저장하지 않고 닫았다 다시 열면 저장된 값으로 돌아간다', async () => {
    renderAt('/settings/menus');
    await userEvent.click(await screen.findByRole('button', { name: /수분 관리/ }));
    const name = within(await sheet()).getByLabelText('이름');
    await userEvent.clear(name);
    await userEvent.type(name, '고치던 이름');
    await userEvent.keyboard('{Escape}');
    await closed();
    await userEvent.click(await screen.findByRole('button', { name: /수분 관리/ }));
    expect(within(await sheet()).getByLabelText('이름')).toHaveValue('수분 관리');
  });

  it('응답만 끊긴 추가는 닫았다 다시 열어도 입력과 키가 남아 한 번만 저장된다(#59 리뷰와 같은 경우)', async () => {
    const api = createMemorySettingsApi();
    const keys: (string | undefined)[] = [];
    let dropResponse = true;
    const flaky: SettingsApi = {
      ...api,
      addMenu: async (input, o) => {
        keys.push(o?.idempotencyKey);
        const created = await api.addMenu(input, o); // 서버에는 저장된다
        if (dropResponse) throw new Error('response lost');
        return created;
      },
    };
    renderAt('/settings/menus', flaky);
    await userEvent.click(await screen.findByRole('button', { name: '메뉴 추가' }));
    let d = await sheet();
    await userEvent.type(within(d).getByLabelText('이름'), '얼굴 관리');
    await save(d);
    expect(await within(d).findByRole('alert')).toHaveTextContent('저장하지 못했어요');
    await userEvent.keyboard('{Escape}');
    await closed();
    expect(await rows()).toContain('얼굴 관리시간 안 정함›'); // 닫을 때 목록을 다시 읽음

    dropResponse = false;
    await userEvent.click(screen.getByRole('button', { name: '메뉴 추가' }));
    d = await sheet();
    expect(within(d).getByLabelText('이름')).toHaveValue('얼굴 관리');
    await save(d);
    await closed();
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    expect((await api.listMenus()).filter((m) => m.name === '얼굴 관리')).toHaveLength(1);
  });

  it('저장 중에는 시트를 닫을 수 없고, 응답이 오면 한 번만 저장된다(#61 옵마 리뷰)', async () => {
    const api = createMemorySettingsApi();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow: SettingsApi = {
      ...api,
      addMenu: async (input, o) => {
        await gate; // 응답이 늦다
        return api.addMenu(input, o);
      },
    };
    renderAt('/settings/menus', slow);
    await userEvent.click(await screen.findByRole('button', { name: '메뉴 추가' }));
    const d = await sheet();
    await userEvent.type(within(d).getByLabelText('이름'), '얼굴 관리');
    await save(d);
    await userEvent.keyboard('{Escape}'); // 응답 전에 닫으려 해도
    expect(screen.getByRole('dialog', { name: '메뉴 추가' })).toBeInTheDocument();
    release();
    await closed();
    expect((await api.listMenus()).filter((m) => m.name === '얼굴 관리')).toHaveLength(1);
  });

  it('다른 곳에서 먼저 고쳤으면 안내하고 새 내용으로 다시 채운다', async () => {
    const api = createMemorySettingsApi();
    renderAt('/settings/menus', api);
    await userEvent.click(await screen.findByRole('button', { name: /수분 관리/ }));
    const d = await sheet();
    // 그사이 다른 기기에서 이름을 바꿨다.
    const [first] = await api.listMenus();
    await api.updateMenu(first!.id, { version: first!.version, name: '수분 진정 관리' });

    await press(d, '관리 시간 5분 늘리기');
    await save(d);
    expect(await screen.findByText(MENU_CONFLICT_TEXT)).toBeInTheDocument();
    expect(within(await sheet()).getByLabelText('이름')).toHaveValue('수분 진정 관리');
    expect((await api.listMenus())[0]).toMatchObject({ name: '수분 진정 관리', defaultDurationMin: 60 });
  });
});
