// C-03 수용 기준: 모바일 화면에서 목록·검색·고객 카드. 데이터는 합성(절대 규칙 8).
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { describe, expect, it } from 'vitest';
import { createMemoryCustomerApi, CustomerApiProvider, type CustomerApi } from '@/features/customers/api';
import { visitStatusText, walletBalance, type WalletEntry } from '@/features/customers/model';
import { routes } from '@/routes';

function renderAt(path: string, api: CustomerApi = createMemoryCustomerApi()) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <CustomerApiProvider value={api}>
      <RouterProvider router={router} />
    </CustomerApiProvider>,
  );
  return router;
}

const names = () => within(screen.getByRole('list', { name: '고객 목록' })).getAllByRole('link').map((a) => a.textContent);

describe('고객 목록·검색', () => {
  const search = async (text: string) => {
    await screen.findByRole('list', { name: '고객 목록' });
    await userEvent.type(screen.getByRole('searchbox', { name: '고객 검색' }), text);
  };

  it('이름으로 찾는다 — 띄어쓰기는 무시, 검색어는 주소에 남기지 않는다', async () => {
    const router = renderAt('/customers');
    await search('이 서윤');
    expect(names()).toEqual(['이서윤010-0000-0003']);
    expect(router.state.location.search).toBe('');
  });

  it('전화번호 일부로 찾는다', async () => {
    renderAt('/customers');
    await search('0002');
    expect(names()).toEqual(['김하늘010-0000-0002']);
  });

  it('검색 결과 없음과 불러오기 실패를 다르게 보여 준다', async () => {
    renderAt('/customers');
    await search('없는사람');
    expect(await screen.findByText('검색 결과가 없어요')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('고객 카드에서 뒤로 오면 검색이 유지된다', async () => {
    const router = renderAt('/customers');
    await search('서윤');
    await userEvent.click(screen.getByRole('link', { name: /이서윤/ }));
    await screen.findByRole('heading', { level: 1, name: '이서윤' });
    await router.navigate(-1);
    expect(await screen.findByRole('searchbox', { name: '고객 검색' })).toHaveValue('서윤');
    expect(names()).toEqual(['이서윤010-0000-0003']);
  });

  it('불러오기에 실패하면 다시 시도할 수 있다', async () => {
    const real = createMemoryCustomerApi();
    let fail = true;
    const api: CustomerApi = { ...real, list: (q) => (fail ? Promise.reject(new Error('offline')) : real.list(q)) };
    renderAt('/customers', api);
    expect(await screen.findByRole('alert')).toHaveTextContent('불러오지 못했어요');
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: '다시 시도' }));
    expect(await screen.findByRole('list', { name: '고객 목록' })).toBeInTheDocument();
  });
});

describe('고객 카드: 지갑·방문 기록', () => {
  it('지갑 잔액과 방문 상태를 한 화면에 보여 준다', async () => {
    renderAt('/customers/c1');
    expect(await screen.findByLabelText('지갑 잔액')).toHaveTextContent('잔액 240,000원');
    const visits = within(screen.getByRole('list', { name: '방문 기록' })).getAllByRole('listitem');
    expect(visits.map((v) => v.lastChild?.textContent)).toEqual(['방문 예정', '완료', '노쇼', '완료']);
  });

  it('없는 고객은 안내를 보여 준다', async () => {
    renderAt('/customers/nope');
    expect(await screen.findByText('없는 고객이에요')).toBeInTheDocument();
  });

  it('잔액은 기록의 합, 지난 확정 세션은 완료', () => {
    const e = (label: WalletEntry['label'], amount: number): WalletEntry => ({ id: label, at: '', label, amount, memo: null, createdBy: 'owner' });
    expect(walletBalance([e('payment', 100_000), e('deduct', -30_000), e('refund', -20_000), e('other', 5_000)])).toBe(55_000);
    const now = new Date('2026-11-19T00:00:00Z');
    expect(visitStatusText({ id: 'a', startsAt: '2026-11-18T02:00:00Z', menu: '', status: 'confirmed' }, now)).toBe('완료');
    expect(visitStatusText({ id: 'b', startsAt: '2026-11-20T02:00:00Z', menu: '', status: 'confirmed' }, now)).toBe('방문 예정');
  });
});
