// 설계 04 보강·05 D3·D5: 캘린더 실제 어댑터(조회·설정 실패 분리·담당자 열·상태 version·재시도 키·거부 이유). 합성 데이터만.
import { render, screen } from '@testing-library/react';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { describe, expect, it } from 'vitest';
import { SessionLoaderProvider } from '@/features/auth/session';
import { CalendarApiProvider, createMemoryCalendarApi, type CalendarApi } from '@/features/calendar/api';
import { rejectText } from '@/features/calendar/bookingText';
import { createHttpCalendarApi } from '@/features/calendar/httpApi';
import { seedCalendar } from '@/features/calendar/mockData';
import { createHttp, type Fetcher } from '@/lib/http';
import { routes } from '@/routes';

type Reply = Response | Error | ((url: string) => Response);
interface Sent {
  url: string;
  method: string;
  key: string | undefined;
  body: unknown;
}
function fake(replies: Record<string, Reply[]>) {
  const sent: Sent[] = [];
  const fetcher: Fetcher = async (url, init) => {
    const method = init.method ?? 'GET';
    const headers = init.headers as Record<string, string>;
    sent.push({ url, method, key: headers['Idempotency-Key'], body: init.body ? JSON.parse(init.body as string) : undefined });
    const route = `${method} ${url.split('?')[0]!.replace('/api/shops/shop-1', '')}`;
    const next = replies[route]?.shift();
    if (!next) throw new Error(`준비한 응답이 없다: ${route}`);
    if (typeof next === 'function') return next(url);
    if (!(next instanceof Response)) throw next;
    return next;
  };
  return { api: createHttpCalendarApi(createHttp(fetcher), 'shop-1'), sent };
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const fail = (status: number, code: string, details: unknown = {}) => json(status, { code, message: '서버 문구', details });
const meta = { createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z' };
const staff = (id: string, active = true) => ({ id, name: `합성 ${id}`, active, version: 1, ...meta });
const appt = (id: string, over: Record<string, unknown> = {}) => ({
  id, customerId: 'c1', customerName: '합성 고객', menuId: null, menuName: null, staffId: 's1',
  startAt: '2026-12-01T01:00:00.000Z', durationMin: 60, prepMin: 10, memo: null, status: 'scheduled', version: 1, blockedBy: [], ...meta, ...over,
});
const hours = { businessHours: { '2': [{ open: '10:00', close: '20:00' }] } };

describe('캘린더 조회', () => {
  it('기간을 쿼리로 보내고, 설정과 함께 읽고, 예약이 남지 않은 비활성 담당자는 열을 만들지 않는다', async () => {
    const { api, sent } = fake({
      'GET /calendar': [json(200, {
        staff: [staff('s1'), staff('off-shown', false), staff('off-cancelled', false)],
        appointments: [appt('a1'), appt('a2', { staffId: 'off-shown' }), appt('a3', { staffId: 'off-cancelled', status: 'cancelled' })],
        blocks: [],
      })],
      'GET /settings/business-hours': [json(200, hours)],
      'GET /closures': [json(200, { items: [{ id: 'cl', kind: 'weekly', weekday: 7, note: null }] })],
    });
    const data = await api.range('2026-11-30', '2026-12-06');
    expect(sent.find((s) => s.url.includes('/calendar'))!.url).toBe('/api/shops/shop-1/calendar?from=2026-11-30&to=2026-12-06');
    expect(data.staff.map((s) => s.id)).toEqual(['s1', 'off-shown']);
    expect(data.appointments.map((a) => [a.id, a.status, a.version])).toEqual([['a1', 'scheduled', 1], ['a2', 'scheduled', 1], ['a3', 'cancelled', 1]]);
    expect(data.businessHours).toEqual(hours.businessHours);
    expect(data.closures).toHaveLength(1);
    expect(data.hoursUnavailable).toBeUndefined();
  });

  it('설정만 실패하면 예약은 주고 hoursUnavailable, 캘린더가 실패하면 던진다', async () => {
    const { api } = fake({
      'GET /calendar': [json(200, { staff: [staff('s1')], appointments: [appt('a1')], blocks: [] }), fail(400, 'INVALID_RANGE')],
      'GET /settings/business-hours': [fail(500, 'UNKNOWN'), json(200, hours)],
      'GET /closures': [json(200, { items: [] }), json(200, { items: [] })],
    });
    const data = await api.range('2026-12-01', '2026-12-01');
    expect(data).toMatchObject({ businessHours: null, closures: [], hoursUnavailable: true });
    expect(data.appointments).toHaveLength(1);
    await expect(api.range('2026-12-01', '2026-11-01')).rejects.toMatchObject({ code: 'INVALID_RANGE' });
  });
});

describe('상태 바꾸기', () => {
  it('읽은 version으로 취소하고, 되돌리기는 방금 저장한 version으로 보낸다', async () => {
    const { api, sent } = fake({
      'GET /calendar': [json(200, { staff: [staff('s1')], appointments: [appt('a1', { version: 4 })], blocks: [] })],
      'GET /settings/business-hours': [json(200, hours)],
      'GET /closures': [json(200, { items: [] })],
      'PUT /appointments/a1/status': [json(200, appt('a1', { status: 'cancelled', version: 5 })), json(200, appt('a1', { version: 6 }))],
    });
    await api.range('2026-12-01', '2026-12-01');
    expect(await api.setStatus('a1', 'cancelled')).toMatchObject({ ok: true, value: { status: 'cancelled', version: 5 } });
    expect(await api.setStatus('a1', 'scheduled')).toMatchObject({ ok: true, value: { status: 'scheduled', version: 6 } });
    const puts = sent.filter((s) => s.method === 'PUT');
    expect(puts.map((s) => s.body)).toEqual([{ version: 4, status: 'cancelled' }, { version: 5, status: 'scheduled' }]);
    expect(puts[0]!.key).toBeTruthy();
    expect(puts[1]!.key).not.toBe(puts[0]!.key);
  });

  it('처음 보는 예약은 상세를 읽고, 응답을 못 받으면 NETWORK → 같은 요청은 같은 키로 다시, 거절은 이유로', async () => {
    const { api, sent } = fake({
      'GET /appointments/a9': [json(200, appt('a9', { version: 2 }))],
      'PUT /appointments/a9/status': [
        new TypeError('Failed to fetch'),
        fail(409, 'STAFF_OVERLAP', { conflictingIds: ['a3'] }),
        fail(409, 'VERSION_CONFLICT', { currentVersion: 3 }),
      ],
    });
    expect(await api.setStatus('a9', 'scheduled')).toEqual({ ok: false, reason: 'NETWORK', conflictingIds: [] });
    expect(await api.setStatus('a9', 'scheduled')).toEqual({ ok: false, reason: 'STAFF_OVERLAP', conflictingIds: ['a3'] });
    const puts = sent.filter((s) => s.method === 'PUT');
    expect(puts[1]!.key).toBe(puts[0]!.key);
    expect(puts.map((s) => s.body)).toEqual([{ version: 2, status: 'scheduled' }, { version: 2, status: 'scheduled' }]);
    expect(await api.setStatus('a9', 'scheduled')).toMatchObject({ ok: false, reason: 'VERSION_CONFLICT' });
    expect(sent.filter((s) => s.method === 'PUT')[2]!.key).not.toBe(puts[0]!.key);
  });
});

describe('예약 등록', () => {
  it('메뉴 id·준비 시간을 그대로 보내고, 영업시간 밖·겹침은 이유로 돌려준다', async () => {
    const { api, sent } = fake({
      'POST /appointments': [json(201, appt('n1', { menuId: 'm1', menuName: '합성 관리' })), fail(422, 'OUTSIDE_BUSINESS_HOURS')],
    });
    const input = {
      customerId: 'c1', customerName: '합성 고객', customerPhone: null, menuId: 'm1', menuName: '합성 관리',
      staffId: 's1', startAt: '2026-12-01T01:00:00.000Z', durationMin: 60, prepMin: 10, memo: null,
    };
    expect(await api.createAppointment(input, { idempotencyKey: 'k-1' })).toMatchObject({ ok: true, value: { id: 'n1', menuId: 'm1' } });
    expect(sent[0]).toMatchObject({
      key: 'k-1',
      body: { customerId: 'c1', staffId: 's1', menuId: 'm1', startAt: input.startAt, durationMin: 60, prepMin: 10, memo: null },
    });
    expect(await api.createAppointment(input)).toEqual({ ok: false, reason: 'OUTSIDE_BUSINESS_HOURS', conflictingIds: [] });
    await expect(api.createAppointment({ ...input, customerId: null })).rejects.toThrow('CUSTOMER_REQUIRED');
  });

  it('실제 API 거부 문구(설계 05)', () => {
    const ctx = { data: { appointments: [], blocks: [], businessHours: null, staff: [] }, staffId: 's1', startAt: '2026-12-01T01:00:00Z' };
    expect(rejectText('NO_CHANGE', [], ctx)).toBe('이미 같은 상태예요.');
    expect(rejectText('VERSION_CONFLICT', [], ctx)).toBe('그사이 다른 곳에서 이 예약이 바뀌었어요. 다시 열어 확인해 주세요.');
    expect(rejectText('NETWORK', [], ctx)).toBe('저장 결과를 확인하지 못했어요. 같은 내용으로 다시 시도해 주세요.');
  });
});

describe('캘린더 화면 — 설정만 실패(D3)', () => {
  it('예약은 보이고, 영업시간·휴무를 못 불러왔다고 따로 알린다', async () => {
    const base = createMemoryCalendarApi(seedCalendar('2026-11-18'));
    const api: CalendarApi = { ...base, range: async (f, t) => ({ ...(await base.range(f, t)), businessHours: null, closures: [], hoursUnavailable: true }) };
    const router = createMemoryRouter(routes, { initialEntries: ['/calendar?view=week&date=2026-11-18'] });
    render(
      <SessionLoaderProvider value={async () => ({ shopId: 'shop-1' })}>
        <CalendarApiProvider value={api}>
          <RouterProvider router={router} />
        </CalendarApiProvider>
      </SessionLoaderProvider>,
    );
    expect(await screen.findByText(/영업시간·휴무를 불러오지 못해/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '다시 불러오기' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /김하늘|이서윤|박지민|최유진|정다은/ }).length).toBeGreaterThan(0);
  });
});
