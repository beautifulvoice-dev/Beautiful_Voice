// 설계 06 W3 저장 흐름: 고객 먼저·키 분리·부분 실패 유지·응답 유실 재시도·동명이인·담당자 0/숨김·메뉴 미설정 시간·닫기 확인. 합성 데이터만.
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { describe, expect, it, vi } from 'vitest';
import { SessionLoaderProvider } from '@/features/auth/session';
import { CalendarApiProvider, createMemoryCalendarApi, type CalendarApi } from '@/features/calendar/api';
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
  it('실제 예약 등록은 기존 예약의 시술 앞 빈 시간을 예전 준비 시간으로 막지 않는다', async () => {
    // 11/16 14시의 기존 예약은 시술 60분과 정리 20분이다. 새 예약은 14시에 끝난다.
    const createAppointment = vi.fn<CalendarApi['createAppointment']>(async (input) => ({
      ok: true, value: { ...input, id: 'saved', status: 'scheduled' },
    }));
    renderAt({ ...calendarApi(), persistsAppointments: true, createAppointment });
    const sheet = await openSheet();
    await fill(sheet, { name: '박지민', date: '2026-11-16', time: '13:00' });
    await save(sheet);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '예약 넣기' })).not.toBeInTheDocument());
    expect(createAppointment).toHaveBeenCalledOnce();
    expect(createAppointment).toHaveBeenCalledWith(
      expect.objectContaining({ startAt: '2026-11-16T04:00:00.000Z', durationMin: 60 }),
      expect.objectContaining({ idempotencyKey: expect.any(String) }),
    );
  });

  it('실제 예약 수정도 예전 준비 시간으로 막지 않고 최신 버전과 함께 서버로 보낸다', async () => {
    const seed = seedCalendar('2026-11-18');
    const original = { ...seed.appointments[2]!, customerId: 'c3', durationMin: 60, prepMin: 0, version: 2 };
    seed.appointments[2] = original;
    const updateAppointment = vi.fn<CalendarApi['updateAppointment']>(async (_, change) => ({
      ok: true, value: { ...original, ...change, version: 3 },
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
        // 화면 검사를 지난 뒤 서버만 아는 겹침(동시 저장)을 흉내 낸다.
        if (rejectOnce) {
          rejectOnce = false;
          return { ok: false, reason: 'STAFF_OVERLAP', conflictingIds: [] };
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
          return { ok: false, reason: 'NETWORK', conflictingIds: [] };
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
    const calendar: CalendarApi = { ...cal, createAppointment: async () => ({ ok: false, reason: 'NETWORK', conflictingIds: [] }) };
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

  it('숨긴 담당자는 고를 수 없고, 사용 중인 담당자가 없으면 저장할 수 없다', async () => {
    const cal = calendarApi();
    const withStaff = (staff: { id: string; name: string; active?: boolean }[]): CalendarApi => ({
      ...cal,
      range: async (f, t) => ({ ...(await cal.range(f, t)), staff }),
    });
    renderAt(withStaff([{ id: 's1', name: '원장', active: false }]));
    const sheet = await openSheet();
    expect(within(sheet).getByText('담당자가 없어 저장할 수 없어요. 설정에서 담당자를 먼저 넣어 주세요.')).toBeInTheDocument();
    await fill(sheet, { name: '이서윤' });
    expect(within(sheet).getByRole('button', { name: '저장' })).toBeDisabled();
  });

  it('메뉴에 시간을 안 정했으면 고른 뒤에도 지금 입력을 그대로 둔다', async () => {
    const calendar: CalendarApi = { ...calendarApi(), menus: async () => [{ id: 'm-free', name: '상담', durationMin: null, prepMin: 5 }] };
    renderAt(calendar);
    const sheet = await openSheet();
    await userEvent.click(within(sheet).getByRole('button', { name: '10분 늘리기' }));
    await userEvent.click(await within(sheet).findByText('상담'));
    expect(within(sheet).getByRole('group', { name: '관리 시간' })).toHaveTextContent('70분');
    expect(within(sheet).getByRole('group', { name: '준비 시간' })).toHaveTextContent('5분');
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
