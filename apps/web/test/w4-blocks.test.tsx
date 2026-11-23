// BEA-179 ② W4 실제 연결: 차단 넣기·지우기 창구, blockedBy 겹침 표시, 지우기 확인 시트, 서버 409 BLOCKED 문구. 합성 데이터만.
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { describe, expect, it } from 'vitest';
import { SessionLoaderProvider } from '@/features/auth/session';
import { CalendarApiProvider, createMemoryCalendarApi, type CalendarApi } from '@/features/calendar/api';
import { createHttpCalendarApi } from '@/features/calendar/httpApi';
import { createMemoryCustomerApi, CustomerApiProvider } from '@/features/customers/api';
import { seedCalendar } from '@/features/calendar/mockData';
import { overlapsBlock, overlappingBlocks, type CalendarAppointment } from '@/features/calendar/model';
import { createHttp, type Fetcher } from '@/lib/http';
import { routes } from '@/routes';

type Sent = { url: string; method: string; key: string | undefined; body: unknown };
function fake(...replies: (Response | Error)[]) {
  const sent: Sent[] = [];
  const fetcher: Fetcher = async (url, init) => {
    const headers = init.headers as Record<string, string>;
    sent.push({ url, method: init.method ?? 'GET', key: headers['Idempotency-Key'], body: init.body ? JSON.parse(init.body as string) : undefined });
    const next = replies.shift()!;
    if (!(next instanceof Response)) throw next;
    return next;
  };
  return { api: createHttpCalendarApi(createHttp(fetcher), 'shop-1'), sent };
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const meta = { createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z' };
const blockRow = { id: 'b9', startAt: '2026-12-01T03:00:00.000Z', endAt: '2026-12-01T04:00:00.000Z', allStaff: true, staffIds: [], memo: '점심', version: 1, ...meta };

describe('창구: 차단 넣기·지우기', () => {
  it('넣기는 POST(전체면 빈 staffIds)·키, 지우기는 DELETE ?version·키, 404·409·연결 실패는 이유로', async () => {
    const { api, sent } = fake(
      json(201, blockRow),
      new Response(null, { status: 204 }),
      json(404, { code: 'NOT_FOUND', message: 'x', details: {} }),
      json(409, { code: 'VERSION_CONFLICT', message: 'x', details: { currentVersion: 2 } }),
      new TypeError('Failed to fetch'),
    );
    const made = await api.createBlock(
      { startAt: blockRow.startAt, endAt: blockRow.endAt, allStaff: true, staffIds: ['s1'], memo: '점심' },
      { idempotencyKey: 'k-b' },
    );
    expect(made).toEqual({ id: 'b9', startAt: blockRow.startAt, endAt: blockRow.endAt, allStaff: true, staffIds: [], memo: '점심', version: 1 });
    expect(sent[0]).toMatchObject({ method: 'POST', url: '/api/shops/shop-1/calendar-blocks', key: 'k-b', body: { allStaff: true, staffIds: [] } });
    expect(await api.removeBlock('b9', 1, { idempotencyKey: 'k-d' })).toEqual({ ok: true, value: null });
    expect(sent[1]).toMatchObject({ method: 'DELETE', url: '/api/shops/shop-1/calendar-blocks/b9?version=1', key: 'k-d' });
    expect(await api.removeBlock('b9', 1)).toMatchObject({ ok: false, reason: 'NOT_FOUND' });
    expect(await api.removeBlock('b9', 1)).toMatchObject({ ok: false, reason: 'VERSION_CONFLICT' });
    expect(await api.removeBlock('b9', 1)).toMatchObject({ ok: false, reason: 'NETWORK' });
  });
});

describe('겹침 표시는 서버 blockedBy를 쓴다(설계 09 D5)', () => {
  const a = { id: 'a1', customerName: '합성', menuName: null, staffId: 's1', startAt: '2026-12-01T01:00:00Z', durationMin: 60, prepMin: 0, memo: null, status: 'scheduled' } as CalendarAppointment;
  const far = { id: 'b-far', startAt: '2026-12-02T01:00:00Z', endAt: '2026-12-02T02:00:00Z', allStaff: true, staffIds: [], memo: null };
  it('blockedBy에 id가 있으면 겹침 — 조회 창 밖이라 blocks에 없어도', () => {
    expect(overlapsBlock({ ...a, blockedBy: ['b-outside'] }, [])).toBe(true);
    expect(overlapsBlock({ ...a, blockedBy: [] }, [{ ...far, startAt: a.startAt, endAt: '2026-12-01T03:00:00Z' }])).toBe(false);
    expect(overlappingBlocks({ ...a, blockedBy: ['b-far'] }, [far])).toEqual([far]);
  });
});

function renderAt(api: CalendarApi) {
  const router = createMemoryRouter(routes, { initialEntries: ['/calendar?view=week&date=2026-11-18'] });
  render(
    <SessionLoaderProvider value={async () => ({ shopId: 'shop-1' })}>
      <CalendarApiProvider value={api}>
        <CustomerApiProvider value={createMemoryCustomerApi()}>
          <RouterProvider router={router} />
        </CustomerApiProvider>
      </CalendarApiProvider>
    </SessionLoaderProvider>,
  );
}
const lunch = async () => within(await screen.findByRole('region', { name: '11월 19일' })).getByRole('button', { name: /관리 불가 시간 11\/19\(목\) 12:00–13:00 · 점심/ });

describe('W4 관리 불가 시간 보기·지우기', () => {
  it('칸을 누르면 시간·대상·메모, 지우기 → 확인 시트 → 지우면 캘린더에서 사라진다', async () => {
    renderAt(createMemoryCalendarApi(seedCalendar('2026-11-18')));
    await userEvent.click(await lunch());
    const panel = await screen.findByRole('dialog', { name: '관리 불가 시간' });
    expect(panel).toHaveTextContent('11/19(목) 12:00–13:00');
    expect(panel).toHaveTextContent('모든 담당자');
    await userEvent.click(within(panel).getByRole('button', { name: '지우기' }));
    const ask = await screen.findByRole('alertdialog', { name: /관리 불가 시간을 지울까요/ });
    await userEvent.click(within(ask).getByRole('button', { name: '지우기' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '관리 불가 시간' })).not.toBeInTheDocument());
    expect(within(await screen.findByRole('region', { name: '11월 19일' })).queryByText('관리 불가')).not.toBeInTheDocument();
  });

  it('응답을 못 받으면 다시 지우기는 같은 키, 그사이 바뀌었으면 안내', async () => {
    const base = createMemoryCalendarApi(seedCalendar('2026-11-18'));
    const keys: (string | undefined)[] = [];
    const replies = ['NETWORK', 'VERSION_CONFLICT'] as const;
    let i = 0;
    const api: CalendarApi = {
      ...base,
      removeBlock: async (_id, _v, options) => {
        keys.push(options?.idempotencyKey);
        return { ok: false, reason: replies[i++]!, conflictingIds: [] };
      },
    };
    renderAt(api);
    await userEvent.click(await lunch());
    const panel = await screen.findByRole('dialog', { name: '관리 불가 시간' });
    const removeOnce = async () => {
      await userEvent.click(within(panel).getByRole('button', { name: '지우기' }));
      await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: '지우기' }));
    };
    await removeOnce();
    expect(await within(panel).findByRole('alert')).toHaveTextContent('저장 결과를 확인하지 못했어요');
    await removeOnce();
    expect(keys[1]).toBe(keys[0]);
    expect(await within(await screen.findByRole('dialog', { name: '관리 불가 시간' })).findByRole('alert')).toHaveTextContent('그사이 다른 곳에서');
  });
});

describe('W3: 서버가 409 BLOCKED로 거부하면 관리 불가 문구', () => {
  it('화면이 모르는 차단(다른 곳에서 방금 생김)이면 일반 관리 불가 문구', async () => {
    const base = createMemoryCalendarApi(seedCalendar('2026-11-18'));
    const api: CalendarApi = { ...base, createAppointment: async () => ({ ok: false, reason: 'BLOCKED', conflictingIds: ['b-new'] }) };
    renderAt(api);
    await screen.findByRole('region', { name: '11월 16일' });
    await userEvent.click(screen.getByRole('button', { name: '예약' }));
    const sheet = await screen.findByRole('dialog', { name: '예약 넣기' });
    await userEvent.type(within(sheet).getByPlaceholderText('이름 두 글자'), '이서윤');
    await userEvent.click(await within(sheet).findByRole('button', { name: /^이서윤/ }));
    await userEvent.click(sheet.querySelector<HTMLElement>('#entry-time')!);
    await userEvent.click(await screen.findByRole('option', { name: '19:00' }));
    await userEvent.click(within(sheet).getByRole('button', { name: '저장' }));
    expect(await within(sheet).findByRole('alert')).toHaveTextContent('관리 불가 시간이에요. 시간을 바꿔 주세요.');
  });
});
