// 설계 05 D4·D5: 고객 저장의 응답 유실 재시도(같은 키)와 버전 충돌(초안 유지 → 최신 값 확인 → 새 버전으로 저장). 합성 데이터만.
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { describe, expect, it } from 'vitest';
import { SessionLoaderProvider } from '@/features/auth/session';
import { createMemoryCustomerApi, CustomerApiProvider, CustomerConflictError, type CustomerApi } from '@/features/customers/api';
import { NetworkError } from '@/lib/http';
import { routes } from '@/routes';

function renderAt(path: string, api: CustomerApi) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <SessionLoaderProvider value={async () => ({ shopId: 'shop-1' })}>
      <CustomerApiProvider value={api}>
        <RouterProvider router={router} />
      </CustomerApiProvider>
    </SessionLoaderProvider>,
  );
  return router;
}

const seed = () => ({
  customers: [{ id: 'c1', name: '합성 하나', phone: '01000000001', memo: null, version: 1 }],
  visits: {},
});

describe('고객 저장 — 응답 유실과 충돌', () => {
  it('응답을 못 받으면 같은 내용 재시도에 같은 키, 내용을 고치면 새 키', async () => {
    const base = createMemoryCustomerApi(seed());
    const keys: (string | undefined)[] = [];
    let failNext = 2;
    const api: CustomerApi = {
      ...base,
      async create(input, options) {
        keys.push(options?.idempotencyKey);
        if (failNext-- > 0) throw new NetworkError();
        return base.create(input, options);
      },
    };
    const router = renderAt('/customers/new', api);
    await userEvent.type(await screen.findByLabelText('이름 (필수)'), '합성 새손님');
    await userEvent.click(screen.getByRole('button', { name: '저장' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('저장 결과를 확인하지 못했어요. 같은 내용으로 다시 시도해 주세요.');
    await userEvent.click(screen.getByRole('button', { name: '저장' }));
    expect(keys[1]).toBe(keys[0]);
    await userEvent.type(screen.getByLabelText('전화번호'), '010-0000-0009');
    await userEvent.click(screen.getByRole('button', { name: '저장' }));
    expect(keys[2]).not.toBe(keys[1]);
    await screen.findByRole('heading', { level: 1, name: '합성 새손님' });
    expect(router.state.location.pathname).toMatch(/^\/customers\/c\d+$/);
  });

  it('409면 입력을 그대로 두고, 다시 불러온 최신 version으로 저장한다', async () => {
    const base = createMemoryCustomerApi(seed());
    let current = { id: 'c1', name: '합성 하나', phone: '01000000001', memo: '다른 곳에서 고침', version: 2 };
    const versions: (number | undefined)[] = [];
    const api: CustomerApi = {
      ...base,
      async get(id) {
        const d = await base.get(id);
        return d && { ...d, ...current };
      },
      async update(id, patch, options) {
        versions.push(options?.version);
        if (options?.version !== current.version) throw new CustomerConflictError();
        current = { ...current, ...patch, version: current.version + 1 } as typeof current;
        return { ...current };
      },
    };
    // 처음 읽은 값은 version 1(그 뒤 다른 곳에서 2로 고쳐진 상황)
    let first = true;
    const stale: CustomerApi = {
      ...api,
      async get(id) {
        const d = await api.get(id);
        if (first && d) {
          first = false;
          return { ...d, memo: null, version: 1 };
        }
        return d;
      },
    };
    renderAt('/customers/c1/edit', stale);
    const address = await screen.findByLabelText('거주지');
    await userEvent.type(address, '합성동');
    await userEvent.click(screen.getByRole('button', { name: '저장' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('그사이 다른 곳에서 바뀌었어요');
    await userEvent.click(screen.getByRole('button', { name: '다시 불러오기' }));
    expect(await screen.findByRole('status')).toHaveTextContent('특이사항: 다른 곳에서 고침');
    expect(screen.getByLabelText('거주지')).toHaveValue('합성동');
    await userEvent.click(screen.getByRole('button', { name: '저장' }));
    expect(versions).toEqual([1, 2]);
  });
});
