// C-03 수용 기준: 모바일 화면에서 등록 → 검색 → 수정. 데이터는 합성(절대 규칙 8).
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
  it('이름으로 찾는다 — 띄어쓰기는 무시', async () => {
    renderAt('/customers');
    await screen.findByRole('list', { name: '고객 목록' });
    await userEvent.type(screen.getByRole('searchbox', { name: '고객 검색' }), '이 서윤');
    expect(names()).toEqual(['이서윤010-0000-0003']);
  });

  it('전화번호 일부로 찾는다', async () => {
    renderAt('/customers?q=0002');
    await screen.findByRole('list', { name: '고객 목록' });
    expect(names()).toEqual(['김하늘010-0000-0002']);
  });

  it('검색 결과 없음과 불러오기 실패를 다르게 보여 준다', async () => {
    renderAt('/customers?q=없는사람');
    expect(await screen.findByText('검색 결과가 없어요')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
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

describe('고객 등록 → 검색 → 수정', () => {
  it('이름이 없으면 저장하지 않는다', async () => {
    renderAt('/customers/new');
    await userEvent.click(await screen.findByRole('button', { name: '저장' }));
    expect(screen.getByText('이름을 입력해 주세요.')).toBeInTheDocument();
  });

  it('등록하고, 목록에서 찾고, 전화번호를 고친다', async () => {
    const router = renderAt('/customers/new');
    await userEvent.type(await screen.findByLabelText('이름 (필수)'), '최가람');
    await userEvent.click(screen.getByRole('button', { name: '저장' }));
    expect(await screen.findByRole('heading', { level: 1, name: '최가람' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: '개인 정보' })).toHaveTextContent('전화번호없음');

    await router.navigate('/customers?q=가람');
    await userEvent.click(await screen.findByRole('link', { name: /최가람/ }));
    await userEvent.click(await screen.findByRole('link', { name: '수정' }));
    const phone = await screen.findByLabelText('전화번호');
    await userEvent.type(phone, '010-0000-12');
    await userEvent.click(screen.getByRole('button', { name: '저장' }));
    expect(screen.getByText(/전화번호 형식이 맞지 않아요/)).toBeInTheDocument();

    await userEvent.type(phone, '34');
    await userEvent.click(screen.getByRole('button', { name: '저장' }));
    expect(await screen.findByRole('region', { name: '개인 정보' })).toHaveTextContent('010-0000-1234');
  });

  it('같은 이름이 있으면 확인을 받고, 원장이 다른 고객이라 하면 따로 저장한다', async () => {
    const api = createMemoryCustomerApi();
    renderAt('/customers/new', api);
    await userEvent.type(await screen.findByLabelText('이름 (필수)'), '김하늘');
    await userEvent.click(screen.getByRole('button', { name: '저장' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('같은 이름의 고객이 있어요');
    expect(within(alert).getAllByRole('listitem')).toHaveLength(2);

    await userEvent.click(screen.getByRole('button', { name: '다른 고객이에요, 저장' }));
    expect(await screen.findByRole('heading', { level: 1, name: '김하늘' })).toBeInTheDocument();
    expect(await api.list('김하늘')).toHaveLength(3);
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
