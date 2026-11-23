// 설정 틀(W13): 폰·웹 배치를 CSS로만 바꿔, 화면 폭이 바뀌어도 고치던 입력이 남는다(#78 리뷰). 데이터는 합성(절대 규칙 8).
import { act, render, screen } from '@testing-library/react';
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

describe('설정 틀', () => {
  it('왼쪽 내비는 CSS로만 숨긴다(jsdom은 CSS를 적용하지 않아 클래스로 확인)', async () => {
    setTestWidth(390);
    renderAt('/settings/menus');
    expect(await screen.findByTestId('settings-nav')).toHaveClass('hidden', 'md:block');
  });

  it('고치는 중에 화면 폭이 바뀌어도(태블릿 회전) 입력이 남는다', async () => {
    setTestWidth(1280);
    renderAt('/settings/menus');
    await userEvent.click(await screen.findByRole('button', { name: '메뉴 추가' }));
    const name = await screen.findByLabelText('이름');
    await userEvent.type(name, '얼굴 관리');
    act(() => setTestWidth(390));
    expect(await screen.findByLabelText('이름')).toHaveValue('얼굴 관리');
    act(() => setTestWidth(1280));
    expect(await screen.findByLabelText('이름')).toHaveValue('얼굴 관리');
  });
});
