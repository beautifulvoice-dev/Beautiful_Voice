// W2 바꾸기 → W3 편집(설계 06 ①·D4, 04 Q1·D2, 05 D4·D5). 가짜 저장소에 감시를 씌워 보낸 칸·version·키를 본다. 합성 데이터만.
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { describe, expect, it } from 'vitest';
import { SessionLoaderProvider } from '@/features/auth/session';
import { CalendarApiProvider, createMemoryCalendarApi, type AppointmentChange, type CalendarApi } from '@/features/calendar/api';
import { seedCalendar } from '@/features/calendar/mockData';
import { createMemoryCustomerApi, CustomerApiProvider } from '@/features/customers/api';
import { routes } from '@/routes';

function renderAt(calendar: CalendarApi) {
  const router = createMemoryRouter(routes, { initialEntries: ['/calendar?view=week&date=2026-11-18'] });
  render(
    <SessionLoaderProvider value={async () => ({ shopId: 'shop-1' })}>
      <CalendarApiProvider value={calendar}>
        <CustomerApiProvider value={createMemoryCustomerApi()}>
          <RouterProvider router={router} />
        </CustomerApiProvider>
      </CalendarApiProvider>
    </SessionLoaderProvider>,
  );
}

type Sent = { change: AppointmentChange; key: string | undefined };
/** 바꾸기 요청을 기록한다. replies가 있으면 차례로 그 결과를 먼저 돌려준다(저장소는 그때 안 바뀐다). */
function spied(replies: ('VERSION_CONFLICT' | 'NETWORK_AFTER_SAVE')[] = []) {
  const base = createMemoryCalendarApi(seedCalendar('2026-11-18'));
  const sent: Sent[] = [];
  const done = new Map<string, Awaited<ReturnType<CalendarApi['updateAppointment']>>>();
  const api: CalendarApi = {
    ...base,
    async updateAppointment(id, change, options) {
      const key = options?.idempotencyKey;
      sent.push({ change, key });
      if (key && done.has(key)) return done.get(key)!; // 서버처럼 같은 키는 처음 결과 재생
      const next = replies.shift();
      if (next === 'VERSION_CONFLICT') return { ok: false, reason: 'VERSION_CONFLICT', conflictingIds: [] };
      const r = await base.updateAppointment(id, change, options);
      if (key) done.set(key, r);
      return next === 'NETWORK_AFTER_SAVE' ? { ok: false, reason: 'NETWORK', conflictingIds: [] } : r;
    },
  };
  return { api, base, sent };
}

/** 화 11/17 최유나(11:30, 90분)를 열고 더보기 → 바꾸기. */
async function openEdit() {
  const tuesday = await screen.findByRole('region', { name: '11월 17일' });
  await userEvent.click(within(tuesday).getByRole('button', { name: /최유나/ }));
  const panel = await screen.findByRole('dialog', { name: '최유나' });
  await userEvent.click(within(panel).getByRole('button', { name: '더보기' }));
  await userEvent.click(within(panel).getByRole('button', { name: '바꾸기' }));
  const sheet = await screen.findByRole('dialog', { name: '예약 바꾸기' });
  await waitFor(() => expect(sheet.querySelector('#entry-time')).toHaveTextContent('11:30'));
  return sheet;
}
async function pickTime(sheet: HTMLElement, hhmm: string) {
  await userEvent.click(sheet.querySelector<HTMLElement>('#entry-time')!);
  await userEvent.click(await screen.findByRole('option', { name: hhmm }));
  await waitFor(() => expect(sheet.querySelector('#entry-time')).toHaveTextContent(hhmm));
}
const save = (sheet: HTMLElement) => userEvent.click(within(sheet).getByRole('button', { name: '저장' }));
const closed = () => waitFor(() => expect(screen.queryByRole('dialog', { name: '예약 바꾸기' })).not.toBeInTheDocument());

describe('W2 바꾸기', () => {
  it('최신 상세로 채워 열고, 시각만 바꾸면 version과 startAt만 보내고 캘린더에 반영된다', async () => {
    const { api, sent } = spied();
    renderAt(api);
    const sheet = await openEdit();
    expect(within(sheet).getByPlaceholderText('이름 두 글자')).toHaveValue('최유나');
    expect(within(sheet).getByRole('group', { name: '관리 시간' })).toHaveTextContent('90분');
    await pickTime(sheet, '15:00');
    await save(sheet);
    await closed();
    expect(sent).toHaveLength(1);
    expect(Object.keys(sent[0]!.change).sort()).toEqual(['startAt', 'version']);
    expect(sent[0]!.change.version).toBe(1);
    const tuesday = await screen.findByRole('region', { name: '11월 17일' });
    await waitFor(() => expect(within(tuesday).getByRole('button', { name: /최유나/ })).toHaveTextContent('15:00'));
  });

  it('바꾼 것 없이 닫으면 예약 보기(W2)로 돌아오고, 바꾼 뒤 닫으면 먼저 묻는다', async () => {
    renderAt(spied().api);
    let sheet = await openEdit();
    await userEvent.click(within(sheet).getByRole('button', { name: '닫기' }));
    expect(await screen.findByRole('dialog', { name: '최유나' })).toBeInTheDocument();
    sheet = await (async () => {
      const panel = screen.getByRole('dialog', { name: '최유나' });
      await userEvent.click(within(panel).getByRole('button', { name: '더보기' }));
      await userEvent.click(within(panel).getByRole('button', { name: '바꾸기' }));
      const s = await screen.findByRole('dialog', { name: '예약 바꾸기' });
      await waitFor(() => expect(s.querySelector('#entry-time')).toHaveTextContent('11:30'));
      return s;
    })();
    await pickTime(sheet, '15:00');
    await userEvent.click(within(sheet).getByRole('button', { name: '닫기' }));
    expect(await screen.findByRole('alertdialog', { name: '입력한 내용이 저장되지 않았어요. 닫을까요?' })).toBeInTheDocument();
  });

  it('바꾸기 중에 + 예약을 눌러도 편집 폼을 바꾸지 않는다 — 바꾼 입력이 사라지지 않는다(#77 리뷰)', async () => {
    renderAt(spied().api);
    const sheet = await openEdit();
    await pickTime(sheet, '15:00');
    await userEvent.click(screen.getByRole('button', { name: '예약' }));
    expect(screen.getByRole('dialog', { name: '예약 바꾸기' })).toBe(sheet);
    expect(screen.queryByRole('dialog', { name: '예약 넣기' })).not.toBeInTheDocument();
    expect(sheet.querySelector('#entry-time')).toHaveTextContent('15:00');
  });

  it('영업시간 밖으로 옮기면 W3와 같은 거부 문구, 저장하지 않는다', async () => {
    const { api, sent } = spied();
    renderAt(api);
    const sheet = await openEdit();
    await pickTime(sheet, '21:30');
    await save(sheet);
    expect(await within(sheet).findByRole('alert')).toHaveTextContent('영업시간(10:00–22:00) 밖이에요.');
    expect(sent).toHaveLength(0);
  });

  it('409면 입력을 두고 최신 값을 불러온 뒤, 새 version·새 키로 다시 저장한다', async () => {
    const { api, base, sent } = spied(['VERSION_CONFLICT']);
    renderAt(api);
    const sheet = await openEdit();
    await pickTime(sheet, '15:00');
    // 그사이 다른 곳에서 메모를 고쳤다(version 1 → 2).
    const other = await base.appointment((await base.range('2026-11-17', '2026-11-17')).appointments[0]!.id);
    await base.updateAppointment(other!.id, { version: 1, memo: '다른 곳에서 고침' });
    await save(sheet);
    const alert = await within(sheet).findByRole('alert');
    expect(alert).toHaveTextContent('그사이 다른 곳에서 이 예약이 바뀌었어요.');
    await userEvent.click(within(alert).getByRole('button', { name: '최신 값 불러오기' }));
    expect(await within(sheet).findByText(/최신 값: 11\/17\(화\) 11:30/)).toBeInTheDocument();
    expect(sheet.querySelector('#entry-time')).toHaveTextContent('15:00');
    await save(sheet);
    await closed();
    expect(sent.map((s) => s.change.version)).toEqual([1, 2]);
    expect(sent[1]!.key).not.toBe(sent[0]!.key);
    // 손대지 않은 메모는 최신 값으로 맞춰져 다시 보내지 않는다 — 다른 곳의 변경을 덮지 않는다(#77 리뷰).
    expect(Object.keys(sent[1]!.change).sort()).toEqual(['startAt', 'version']);
    expect((await base.appointment(other!.id))?.memo).toBe('다른 곳에서 고침');
  });

  it('저장된 뒤 응답만 유실되면, 다시 저장은 같은 요청·같은 키로 확인한다', async () => {
    const { api, sent } = spied(['NETWORK_AFTER_SAVE']);
    renderAt(api);
    const sheet = await openEdit();
    await pickTime(sheet, '15:00');
    await save(sheet);
    expect(await within(sheet).findByRole('alert')).toHaveTextContent('바꾼 내용이 저장됐는지 확인하지 못했어요.');
    await save(sheet);
    await closed();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
  });
});
