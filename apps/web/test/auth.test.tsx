// C-10 로그인 화면 (U-1·U-2): 로그인 안 했으면 로그인 화면, 했으면 매장 화면. 데이터는 합성.
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchSession, SessionLoaderProvider, type SessionLoader } from '@/features/auth/session';
import { routes } from '@/routes';

function renderAt(path: string, loader: SessionLoader) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <SessionLoaderProvider value={loader}>
      <RouterProvider router={router} />
    </SessionLoaderProvider>,
  );
  return router;
}

describe('로그인 확인', () => {
  it('로그인하지 않았으면 로그인 화면으로 보낸다', async () => {
    const router = renderAt('/customers', async () => null);
    const button = await screen.findByRole('link', { name: '카카오로 로그인' });
    expect(router.state.location.pathname).toBe('/login');
    expect(button).toHaveAttribute('href', '/api/auth/kakao/start');
    expect(screen.queryByRole('navigation', { name: '주 메뉴' })).not.toBeInTheDocument();
  });

  it('로그인했으면 원래 화면을 보여 준다', async () => {
    const router = renderAt('/customers', async () => ({ shopId: 'shop-1' }));
    expect(await screen.findByRole('navigation', { name: '주 메뉴' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/customers');
  });

  it('로그인 확인에 실패하면 로그인 화면이 아니라 다시 시도를 보여 준다', async () => {
    let fail = true;
    const router = renderAt('/calendar', async () => {
      if (fail) throw new Error('offline');
      return { shopId: 'shop-1' };
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('불러오지 못했어요');
    expect(router.state.location.pathname).toBe('/calendar');
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: '다시 시도' }));
    expect(await screen.findByRole('navigation', { name: '주 메뉴' })).toBeInTheDocument();
  });
});

describe('fetchSession — /api/auth/session 응답 해석', () => {
  afterEach(() => vi.unstubAllGlobals());
  const respond = (status: number, body: unknown) =>
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })));

  it('200이면 매장 ID', async () => {
    respond(200, { shopId: '00000000-0000-4000-8000-000000000001' });
    expect(await fetchSession()).toEqual({ shopId: '00000000-0000-4000-8000-000000000001' });
  });

  it('401이면 로그인 안 됨', async () => {
    respond(401, { code: 'UNAUTHENTICATED', message: '', details: {} });
    expect(await fetchSession()).toBeNull();
  });

  it('503 등 다른 오류는 실패로 알린다', async () => {
    respond(503, { code: 'AUTH_UNAVAILABLE', message: '', details: {} });
    await expect(fetchSession()).rejects.toThrow();
  });
});
