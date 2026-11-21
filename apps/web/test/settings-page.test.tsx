// 설정 틀(W13 디자인 11/20): 폰은 목록(제목 아래 요약) → 하위 화면, 웹은 왼쪽 메뉴 + 오른쪽 내용. 데이터는 합성(절대 규칙 8).
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { describe, expect, it } from 'vitest';
import { SessionLoaderProvider } from '@/features/auth/session';
import { createMemorySettingsApi, SettingsApiProvider } from '@/features/settings/api';
import { routes } from '@/routes';
import { setTestWidth } from './setup';

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <SessionLoaderProvider value={async () => ({ shopId: 'shop-1' })}>
      <SettingsApiProvider value={createMemorySettingsApi()}>
        <RouterProvider router={router} />
      </SettingsApiProvider>
    </SessionLoaderProvider>,
  );
  return router;
}

describe('설정 — 폰(390px)', () => {
  it('항목마다 제목 아래 요약을 보이고, 누르면 하위 화면으로 간다', async () => {
    setTestWidth(390);
    const router = renderAt('/settings');
    const list = await screen.findByRole('list', { name: '설정 항목' });
    const rows = within(list).getAllByRole('link');
    await within(list).findByText('10:00–20:00 외 · 월요일 정기 휴무');
    expect(rows.map((a) => a.textContent)).toEqual([
      '영업시간10:00–20:00 외 · 월요일 정기 휴무›',
      '휴무·휴가다음 휴가 12/24–12/26›',
      '메뉴2개›',
      '담당자원장›',
    ]);
    expect(screen.queryByRole('navigation', { name: '설정 메뉴' })).toBeNull();

    await userEvent.click(rows[2]!);
    expect(router.state.location.pathname).toBe('/settings/menus');
    expect(screen.getByRole('link', { name: '‹ 설정' })).toBeInTheDocument();
  });
});

describe('설정 — 웹(1280px)', () => {
  it('/settings는 첫 항목을 열고, 왼쪽 메뉴에 지금 화면을 표시한다', async () => {
    setTestWidth(1280);
    const router = renderAt('/settings');
    // 넘어가는 동안 화면이 한 번 다시 그려질 수 있어 찾은 뒤 다시 확인한다.
    await waitFor(() => expect(screen.getByRole('heading', { name: '영업시간' })).toBeInTheDocument());
    expect(router.state.location.pathname).toBe('/settings/hours');
    const nav = screen.getByRole('navigation', { name: '설정 메뉴' });
    expect(within(nav).getAllByRole('link').map((a) => a.textContent)).toEqual(['영업시간', '휴무·휴가', '메뉴', '담당자']);
    expect(within(nav).getByRole('link', { name: '영업시간' })).toHaveAttribute('aria-current', 'page');
  });

  it('왼쪽 메뉴로 옮겨 다닌다 — 메뉴는 그대로 남는다', async () => {
    setTestWidth(1280);
    const router = renderAt('/settings/hours');
    const nav = await screen.findByRole('navigation', { name: '설정 메뉴' });
    await userEvent.click(within(nav).getByRole('link', { name: '담당자' }));
    expect(router.state.location.pathname).toBe('/settings/staff');
    expect(await screen.findByRole('heading', { name: '담당자' })).toBeInTheDocument();
    expect(within(screen.getByRole('navigation', { name: '설정 메뉴' })).getByRole('link', { name: '담당자' })).toHaveAttribute('aria-current', 'page');
  });
});
