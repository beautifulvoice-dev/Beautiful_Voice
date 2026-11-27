// 설계 06 W3 저장 흐름: 고객 먼저·키 분리·부분 실패 유지·응답 유실 재시도·동명이인·담당자 0/숨김·메뉴 미설정 시간·닫기 확인. 합성 데이터만.
// 설계 12 §5-1(rev.3.1): 저장 뒤 새 경고 안내·비교 탭, 담당자 미지정·담당자 필수.
import type { BookingWarning } from '@bv/contracts';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { describe, expect, it, vi } from 'vitest';
import { SessionLoaderProvider } from '@/features/auth/session';
import { CalendarApiProvider, createMemoryCalendarApi, type CalendarApi } from '@/features/calendar/api';
import { newWarnings } from '@/features/calendar/bookingText';
import { seedCalendar } from '@/features/calendar/mockData';
import { createMemoryCustomerApi, CustomerApiProvider, type CustomerApi } from '@/features/customers/api';
import { routes } from '@/routes';

function renderAt(calendar: CalendarApi, customers: CustomerApi = createMemoryCustomerApi()) {
  const router = createMemoryRouter(routes, { initialEntries: ['/calendar?date=2026-11-18'] });
  render(
    <SessionLoaderProvider value={async () => ({ shopId: 'shop-1' })}>
      <CalendarApiProvider value={calendar}>
        <CustomerApiProvider value={customers}>
          <RouterProvider router={router} />
        </CustomerApiProvider>
      </CalendarApiProvider>
    </SessionLoaderProvider>,
  );
}
const calendarApi = () => createMemoryCalendarApi(seedCalendar('2026-11-18'));

async function openSheet() {
  await screen.findByRole('region', { name: '11월 16일' });
  await userEvent.click(screen.getByRole('button', { name: '예약' }));
  return screen.findByRole('dialog', { name: '예약 넣기' });
}
async function fill(sheet: HTMLElement, { name, newCustomer = false, date = '2026-11-17', time = '15:00' }: { name: string; newCustomer?: boolean; date?: string; time?: string }) {
  await userEvent.type(within(sheet).getByPlaceholderText('이름 두 글자'), name);
  await userEvent.click(
    await within(sheet).findByRole('button', { name: newCustomer ? `"${name}" 새 고객으로 넣기` : new RegExp(`^${name}`) }),
  );
  // 날짜는 달력 팝업, 시작은 15분 목록에서 고른다(#69 고르기 부품).
  await userEvent.click(within(sheet).getByRole('button', { name: /달력 열기/ }));
  const [y, m, d] = date.split('-').map(Number);
  await userEvent.click(await screen.findByRole('button', { name: new RegExp(`^${y}년 ${m}월 ${d}일`) }));
  await waitFor(() => expect(within(sheet).getByRole('button', { name: /달력 열기/ })).toHaveTextContent(`${m}/${d}(`));
  await userEvent.click(sheet.querySelector<HTMLElement>('#entry-time')!);
  await userEvent.click(await screen.findByRole('option', { name: time }));
  await waitFor(() => expect(sheet.querySelector('#entry-time')).toHaveTextContent(time));
}
const save = (sheet: HTMLElement) => userEvent.click(within(sheet).getByRole('button', { name: '저장' }));

describe('W3 저장 흐름(설계 06)', () => {
  it('미리 보기에 없던 겹침이 저장 응답에 오면 "저장했어요 · 새로 겹치는 예약 1건", 누르면 상세의 기존 예약 탭(설계 12 §5-1)', async () => {
    const cal = calendarApi();
    // 미리 보기 뒤 다른 곳에서 같은 시각 예약이 생긴 경우를 흉내 낸다: 미리 보기는 빈 목록, 저장은 a3(박지민)과 겹침.
    const calendar: CalendarApi = {
      ...cal,
      previewWarnings: async () => [],
      async createAppointment(input, options) {
        const r = await cal.createAppointment(input, options);
        return r.ok ? { ok: true, value: { ...r.value, warnings: [{ code: 'OVERLAP_APPOINTMENT', relatedIds: ['a3'] }] } } : r;
      },
    };
    renderAt(calendar);
    const sheet = await openSheet();
    await fill(sheet, { name: '박지민', date: '2026-11-16', time: '16:00' });
    expect(within(sheet).queryByText(/겹쳐요/)).not.toBeInTheDocument();
    await save(sheet);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '예약 넣기' })).not.toBeInTheDocument());
    expect(await screen.findByText('저장했어요 · 새로 겹치는 예약 1건')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '보기' }));
    const detail = await screen.findByRole('dialog', { name: '박지민' });
    expect(within(detail).getByRole('radio', { name: /기존 예약 1/ })).toBeChecked();
    expect(within(detail).getByRole('list', { name: '겹치는 기존 예약' })).toHaveTextContent('11/16(월) 16:00–16:50 · 50분');
    await userEvent.click(within(detail).getByRole('radio', { name: '요청 예약' }));
    expect(detail).toHaveTextContent('11/16(월) 16:00–17:00 · 60분');
  });

  it('새 고객 입력 중에도 미리 보기를 부른다 — 고객 id 없이(옵마 11/27)', async () => {
    const cal = calendarApi();
    const previewWarnings = vi.fn<CalendarApi['previewWarnings']>((input) => cal.previewWarnings(input));
    renderAt({ ...cal, previewWarnings });
    const sheet = await openSheet();
    await fill(sheet, { name: '합성새손', newCustomer: true, date: '2026-11-16', time: '14:30' });
    expect(await within(sheet).findByText('14:00–15:00 이서윤 님 예약과 겹쳐요.')).toBeInTheDocument();
    expect(previewWarnings.mock.lastCall![0]).not.toHaveProperty('customerId');
  });

  it('미리 보기와 저장 경고가 순서만 다르면 새 경고가 아니고, 대상이 한 건 늘면 그 한 건만 새 것이다', () => {
    const a: BookingWarning = { code: 'OVERLAP_APPOINTMENT', relatedIds: ['x', 'y'] };
    const b: BookingWarning = { code: 'OVERLAP_BLOCK', relatedIds: ['b1'] };
    expect(newWarnings([a, b], [b, { ...a, relatedIds: ['y', 'x'] }])).toEqual([]);
    expect(newWarnings([a], [{ ...a, relatedIds: ['x', 'y', 'z'] }])).toEqual([{ code: 'OVERLAP_APPOINTMENT', relatedIds: ['z'] }]);
    expect(newWarnings([], [{ code: 'CLOSED_DAY', relatedIds: [] }])).toEqual([{ code: 'CLOSED_DAY', relatedIds: [] }]);
    expect(newWarnings([{ code: 'CLOSED_DAY', relatedIds: [] }], [{ code: 'CLOSED_DAY', relatedIds: [] }])).toEqual([]);
  });

  it('담당자가 여럿이면 "미지정"을 고를 수 있고 null로 저장한다. 담당자 필수 매장에서는 미지정이 없고 고를 때까지 저장할 수 없다', async () => {
    const two = (required: boolean): CalendarApi => {
      const cal = createMemoryCalendarApi({ ...seedCalendar('2026-11-18'), staff: [{ id: 's1', name: '원장' }, { id: 's2', name: '실장' }] }, [], {
        requireStaffSelection: required,
      });
      return cal;
    };
    const createAppointment = vi.fn<CalendarApi['createAppointment']>(async (input) => ({
      ok: true, value: { ...input, id: 'saved', status: 'scheduled', warnings: [] },
    }));
    renderAt({ ...two(false), createAppointment });
    let sheet = await openSheet();
    await fill(sheet, { name: '박지민' });
    expect(within(sheet).getByRole('radio', { name: '미지정' })).toBeChecked();
    expect(sheet).toHaveTextContent('15:00부터 16:10까지 일정이(담당자 미지정) 잡혀요');
    await save(sheet);
    await waitFor(() => expect(createAppointment).toHaveBeenCalledWith(expect.objectContaining({ staffId: null }), expect.anything()));
    cleanup();

    renderAt(two(true));
    sheet = await openSheet();
    await fill(sheet, { name: '박지민' });
    await waitFor(() => expect(within(sheet).queryByRole('radio', { name: '미지정' })).not.toBeInTheDocument());
    expect(within(sheet).getByText('이 매장은 담당자를 꼭 골라야 해요.')).toBeInTheDocument();
    expect(within(sheet).getByRole('button', { name: '저장' })).toBeDisabled();
    await userEvent.click(within(sheet).getByRole('radio', { name: '실장' }));
    expect(within(sheet).getByRole('button', { name: '저장' })).toBeEnabled();
  });

  it('실제 예약 수정은 최신 버전과 바뀐 칸만 서버로 보낸다', async () => {
    const seed = seedCalendar('2026-11-18');
    const original = { ...seed.appointments[2]!, customerId: 'c3', durationMin: 60, cleanupMin: 0, version: 2 };
    seed.appointments[2] = original;
    const updateAppointment = vi.fn<CalendarApi['updateAppointment']>(async (_, change) => ({
      ok: true, value: { ...original, ...change, version: 3, warnings: [] },
    }));
    renderAt({ ...createMemoryCalendarApi(seed), persistsAppointments: true, updateAppointment });
    const monday = await screen.findByRole('region', { name: '11월 16일' });
    await userEvent.click(within(monday).getByRole('button', { name: /박지민/ }));
    const detail = await screen.findByRole('dialog', { name: '박지민' });
    await userEvent.click(within(detail).getByRole('button', { name: '더보기' }));
    await userEvent.click(within(detail).getByRole('button', { name: '바꾸기' }));
    const sheet = await screen.findByRole('dialog', { name: '예약 바꾸기' });
    await waitFor(() => expect(sheet.querySelector('#entry-time')).toHaveTextContent('16:00'));
    await userEvent.click(sheet.querySelector<HTMLElement>('#entry-time')!);
    await userEvent.click(await screen.findByRole('option', { name: '13:00' }));
    await save(sheet);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '예약 바꾸기' })).not.toBeInTheDocument());
    expect(updateAppointment).toHaveBeenCalledOnce();
    expect(updateAppointment).toHaveBeenCalledWith(
      original.id,
      { version: 2, startAt: '2026-11-16T04:00:00.000Z' },
      expect.objectContaining({ idempotencyKey: expect.any(String) }),
    );
  });

  it('고객 검색은 두 글자부터, 결과가 있으면 새 고객 제안은 없다', async () => {
    renderAt(calendarApi());
    const sheet = await openSheet();
    const input = within(sheet).getByPlaceholderText('이름 두 글자');
    await userEvent.type(input, '김');
    expect(within(sheet).queryByRole('listbox')).not.toBeInTheDocument();
    await userEvent.type(input, '하늘');
    const list = await within(sheet).findByRole('listbox', { name: '고객 후보' });
    expect(within(list).getAllByRole('button').map((b) => b.textContent)).toEqual(['김하늘···0001', '김하늘···0002']);
  });

  it('새 고객: 고객 먼저 등록(키 하나) → 예약이 거부되면 "고객은 등록됐어요" + 고쳐서 다시 저장해도 고객을 또 만들지 않는다', async () => {
    const base = createMemoryCustomerApi();
    const customerKeys: (string | undefined)[] = [];
    const customers: CustomerApi = {
      ...base,
      create: (input, options) => {
        customerKeys.push(options?.idempotencyKey);
        return base.create(input, options);
      },
    };
    const cal = calendarApi();
    const apptKeys: (string | undefined)[] = [];
    let rejectOnce = true;
    const calendar: CalendarApi = {
      ...cal,
      async createAppointment(input, options) {
        apptKeys.push(options?.idempotencyKey);
        // 서버가 한 번 거절한 경우(500 등)를 흉내 낸다.
        if (rejectOnce) {
          rejectOnce = false;
          return { ok: false, reason: 'FAILED' };
        }
        return cal.createAppointment(input, options);
      },
    };
    renderAt(calendar, customers);
    const sheet = await openSheet();
    await fill(sheet, { name: '합성새손', newCustomer: true });
    await save(sheet);
    expect(await within(sheet).findByRole('alert')).toHaveTextContent('고객은 등록됐어요. 예약은 저장되지 않았어요.');
    expect(customerKeys).toHaveLength(1);
    expect(customerKeys[0]).toBeTruthy();
    expect(apptKeys[0]).not.toBe(customerKeys[0]);
    await save(sheet);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '예약 넣기' })).not.toBeInTheDocument());
    expect(customerKeys).toHaveLength(1);
    expect((await base.list('합성새손')).length).toBe(1);
    const tuesday = await screen.findByRole('region', { name: '11월 17일' });
    expect(within(tuesday).getByRole('button', { name: /합성새손/ })).toBeInTheDocument();
  });

  it('예약이 저장된 뒤 응답만 유실 → 다시 저장은 새 검사 없이 같은 요청·같은 키로 확인해 처음 결과를 받는다', async () => {
    const cal = calendarApi();
    const keys: (string | undefined)[] = [];
    const done = new Map<string, Awaited<ReturnType<CalendarApi['createAppointment']>>>();
    let lose = true;
    const calendar: CalendarApi = {
      ...cal,
      // 서버처럼: 같은 키는 처음 결과를 재생한다. 첫 응답은 저장한 뒤 유실된다.
      async createAppointment(input, options) {
        const key = options?.idempotencyKey ?? '';
        keys.push(key);
        const replay = done.get(key);
        if (replay) return replay;
        const r = await cal.createAppointment(input, options);
        done.set(key, r);
        if (lose) {
          lose = false;
          return { ok: false, reason: 'NETWORK' };
        }
        return r;
      },
    };
    renderAt(calendar);
    const sheet = await openSheet();
    await fill(sheet, { name: '이서윤' });
    await save(sheet);
    const alert = await within(sheet).findByRole('alert');
    expect(alert).toHaveTextContent('예약이 저장됐는지 확인하지 못했어요. 다시 저장하면 같은 요청으로 확인해요.');
    expect(alert).not.toHaveTextContent('저장되지 않았어요');
    await save(sheet);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '예약 넣기' })).not.toBeInTheDocument());
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    const tuesday = await screen.findByRole('region', { name: '11월 17일' });
    expect(within(tuesday).getAllByRole('button', { name: /이서윤/ })).toHaveLength(1);
  });

  it('새 고객 + 예약 응답 유실: "고객은 등록됐어요"는 남기고 예약 미저장은 단정하지 않는다', async () => {
    const cal = calendarApi();
    const calendar: CalendarApi = { ...cal, createAppointment: async () => ({ ok: false, reason: 'NETWORK' }) };
    renderAt(calendar);
    const sheet = await openSheet();
    await fill(sheet, { name: '합성유실', newCustomer: true });
    await save(sheet);
    const alert = await within(sheet).findByRole('alert');
    expect(alert).toHaveTextContent('고객은 등록됐어요. 예약이 저장됐는지 확인하지 못했어요.');
    expect(alert).not.toHaveTextContent('예약은 저장되지 않았어요');
  });

  it('새 고객으로 넣을 때 같은 이름이 있으면 먼저 묻고, "새 고객이 맞아요"로 저장한다', async () => {
    const base = createMemoryCustomerApi();
    let created = 0;
    // 목록 검색은 비게, 동명이인 확인은 후보가 있게(띄어쓰기만 다른 이름 등).
    const customers: CustomerApi = {
      ...base,
      list: async () => [],
      checkSameName: async () => ({ needsReview: true, candidates: [{ customerId: 'c4', name: '박지민', phone: null, hint: 'phone_missing' }] }),
      create: (input, options) => {
        created++;
        return base.create(input, options);
      },
    };
    renderAt(calendarApi(), customers);
    const sheet = await openSheet();
    await fill(sheet, { name: '박지민', newCustomer: true });
    await save(sheet);
    const group = await within(sheet).findByRole('group', { name: '같은 이름 고객' });
    expect(group).toHaveTextContent('같은 이름의 고객이 있어요');
    expect(within(sheet).getByRole('button', { name: '저장' })).toBeDisabled();
    expect(created).toBe(0);
    await userEvent.click(within(group).getByRole('button', { name: '새 고객이 맞아요, 저장' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '예약 넣기' })).not.toBeInTheDocument());
    expect(created).toBe(1);
  });

  it('숨긴 담당자는 고를 수 없고, 담당자 필수 매장에 사용 중인 담당자가 없으면 저장할 수 없다', async () => {
    const cal = calendarApi();
    const withStaff = (staff: { id: string; name: string; active?: boolean }[]): CalendarApi => ({
      ...cal,
      appointmentRules: async () => ({ requireStaffSelection: true }),
      range: async (f, t) => ({ ...(await cal.range(f, t)), staff }),
    });
    renderAt(withStaff([{ id: 's1', name: '원장', active: false }]));
    const sheet = await openSheet();
    expect(await within(sheet).findByText('담당자를 골라야 하는데 담당자가 없어요. 설정에서 담당자를 먼저 넣어 주세요.')).toBeInTheDocument();
    await fill(sheet, { name: '이서윤' });
    expect(within(sheet).getByRole('button', { name: '저장' })).toBeDisabled();
  });

  it('메뉴에 시간을 안 정했으면 고른 뒤에도 지금 입력을 그대로 둔다', async () => {
    const calendar: CalendarApi = { ...calendarApi(), menus: async () => [{ id: 'm-free', name: '상담', durationMin: null, cleanupMin: 5 }] };
    renderAt(calendar);
    const sheet = await openSheet();
    await userEvent.click(within(sheet).getByRole('button', { name: '10분 늘리기' }));
    await userEvent.click(await within(sheet).findByText('상담'));
    expect(within(sheet).getByRole('group', { name: '시술 시간' })).toHaveTextContent('70분');
    expect(within(sheet).getByRole('group', { name: '정리 시간' })).toHaveTextContent('5분');
  });

  it('예약 저장 중에는 닫기와 Escape를 막고 요청 한 건을 끝까지 처리한다', async () => {
    const cal = calendarApi();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    let requests = 0;
    const calendar: CalendarApi = {
      ...cal,
      async createAppointment(input, options) {
        requests++;
        await pending;
        return cal.createAppointment(input, options);
      },
    };
    renderAt(calendar);
    const sheet = await openSheet();
    await fill(sheet, { name: '이서윤' });
    await save(sheet);
    await waitFor(() => expect(requests).toBe(1));
    const close = within(sheet).getByRole('button', { name: '닫기' });
    expect(close).toBeDisabled();
    await userEvent.click(close);
    await userEvent.keyboard('{Escape}');
    expect(sheet).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    release();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '예약 넣기' })).not.toBeInTheDocument());
    expect(requests).toBe(1);
  });

  it('입력을 바꾼 뒤 닫으면 한 번 묻고, 그대로 닫기를 고르면 닫힌다', async () => {
    renderAt(calendarApi());
    const sheet = await openSheet();
    await userEvent.type(within(sheet).getByPlaceholderText('이름 두 글자'), '이서');
    await userEvent.click(within(sheet).getByRole('button', { name: '닫기' }));
    const ask = await screen.findByRole('alertdialog', { name: '입력한 내용이 저장되지 않았어요. 닫을까요?' });
    await userEvent.click(within(ask).getByRole('button', { name: '계속 입력' }));
    expect(screen.getByRole('dialog', { name: '예약 넣기' })).toBeInTheDocument();
    await userEvent.click(within(screen.getByRole('dialog', { name: '예약 넣기' })).getByRole('button', { name: '닫기' }));
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: '닫기' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '예약 넣기' })).not.toBeInTheDocument());
  });
});
