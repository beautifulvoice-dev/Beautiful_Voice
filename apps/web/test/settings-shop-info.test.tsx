// 매장 정보(W13, BEA-166): 링크 https 자동 보완(11/22 옵마), 서버 칸 오류, 저장 키 재시도. 합성 데이터만.
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { describe, expect, it } from 'vitest';
import { SessionLoaderProvider } from '@/features/auth/session';
import { createMemorySettingsApi, FieldsInvalidError, SettingsApiProvider, type SettingsApi } from '@/features/settings/api';
import { completeLink } from '@/features/settings/shopInfo';
import { NetworkError } from '@/lib/http';
import { SHOP_INFO_SAVED_TEXT } from '@/pages/settings/ShopInfoPage';
import { routes } from '@/routes';
import { setTestWidth } from './setup';

function renderAt(path: string, api: SettingsApi) {
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
const field = (name: string) => screen.findByRole('textbox', { name });

describe('링크 보완', () => {
  it('빈 칸은 null, 주소 앞부분이 없으면 https://, 인스타그램 @아이디는 instagram.com 주소', () => {
    expect(completeLink('naverPlaceUrl', '  ')).toBeNull();
    expect(completeLink('naverPlaceUrl', 'naver.me/abc')).toBe('https://naver.me/abc');
    expect(completeLink('landingUrl', 'http://example.com')).toBe('http://example.com');
    expect(completeLink('landingUrl', 'example.com:8443/page')).toBe('https://example.com:8443/page');
    expect(completeLink('instagramUrl', '@raon.beauty')).toBe('https://instagram.com/raon.beauty');
    expect(completeLink('landingUrl', '@raon.beauty')).toBe('https://@raon.beauty');
  });
});

describe('매장 정보 화면', () => {
  it('폰: 제목 위 매장 이름, 디자인 예시 입력을 https 주소로 바꿔 저장하고 칸에 보여 준다', async () => {
    setTestWidth(375);
    const api = createMemorySettingsApi();
    renderAt('/settings/shop-info', api);
    const naver = await field('네이버 플레이스');
    await userEvent.clear(naver);
    await userEvent.type(naver, 'naver.me/raon');
    const insta = await field('인스타그램');
    await userEvent.clear(insta);
    await userEvent.type(insta, '@raon.beauty');
    await userEvent.click(screen.getByRole('button', { name: '저장' }));
    expect(await screen.findByRole('status')).toHaveTextContent(SHOP_INFO_SAVED_TEXT);
    expect(await api.getShopInfo()).toMatchObject({ naverPlaceUrl: 'https://naver.me/raon', instagramUrl: 'https://instagram.com/raon.beauty' });
    expect(await field('인스타그램')).toHaveValue('https://instagram.com/raon.beauty');
  });

  it('미지원 스킴은 각 링크 칸에 오류를 표시하고 기존 주소를 유지한다', async () => {
    const api = createMemorySettingsApi();
    const before = await api.getShopInfo();
    renderAt('/settings/shop-info', api);
    const homepage = await field('홈페이지');
    const naver = await field('네이버 플레이스');
    await userEvent.clear(homepage);
    await userEvent.type(homepage, 'ftp://files.example.com/path');
    await userEvent.clear(naver);
    await userEvent.type(naver, 'mailto:shop@example.com');
    await userEvent.click(screen.getByRole('button', { name: '저장' }));

    await waitFor(() => {
      expect(homepage).toHaveAttribute('aria-invalid', 'true');
      expect(naver).toHaveAttribute('aria-invalid', 'true');
    });
    expect(homepage).toHaveValue('ftp://files.example.com/path');
    expect(naver).toHaveValue('mailto:shop@example.com');
    expect(await api.getShopInfo()).toEqual(before);
    expect(screen.queryByText(SHOP_INFO_SAVED_TEXT)).not.toBeInTheDocument();
  });

  it('서버가 칸을 거부하면 그 칸 아래 이유', async () => {
    const base = createMemorySettingsApi();
    const api: SettingsApi = {
      ...base,
      putShopInfo: async () => {
        throw new FieldsInvalidError([{ field: 'landingUrl', code: 'INVALID_URL' }] as unknown as FieldsInvalidError['errors']);
      },
    };
    renderAt('/settings/shop-info', api);
    await userEvent.type(await field('홈페이지'), 'x');
    await userEvent.click(screen.getByRole('button', { name: '저장' }));
    expect(await screen.findByText('주소를 확인해 주세요. 예: naver.me/abc, @아이디')).toBeInTheDocument();
  });

  it('응답을 못 받으면 같은 내용 재시도에 같은 키', async () => {
    const base = createMemorySettingsApi();
    const keys: (string | undefined)[] = [];
    let lose = true;
    const api: SettingsApi = {
      ...base,
      putShopInfo: async (info, options) => {
        keys.push(options?.idempotencyKey);
        if (lose) {
          lose = false;
          throw new NetworkError();
        }
        return base.putShopInfo(info, options);
      },
    };
    renderAt('/settings/shop-info', api);
    await userEvent.type(await field('위치'), ' 3층');
    const save = () => userEvent.click(screen.getByRole('button', { name: '저장' }));
    await save();
    await screen.findByRole('alert');
    await save();
    await waitFor(() => expect(keys).toHaveLength(2));
    expect(keys[1]).toBe(keys[0]);
  });
});
