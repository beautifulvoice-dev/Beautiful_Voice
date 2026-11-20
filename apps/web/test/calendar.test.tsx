// BEA-175 수용 기준: 주·월 전환 / 관리·준비·차단이 다르게 보임 / 예약 카드에 고객·메뉴·담당자, 누르면 메모.
// 데이터는 합성(절대 규칙 8). 날짜는 주소로 고정해 언제 돌려도 같은 결과가 나오게 한다.
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { describe, expect, it } from 'vitest';
import { SessionLoaderProvider } from '@/features/auth/session';
import { CalendarApiProvider, createMemoryCalendarApi, type CalendarApi } from '@/features/calendar/api';
import { seedCalendar } from '@/features/calendar/mockData';
import {
  appointmentTimeText,
  hourRange,
  monthGrid,
  segmentsForDay,
  weekDays,
  type CalendarAppointment,
} from '@/features/calendar/model';
import { validDate } from '@/pages/calendar/CalendarPage';
import { routes } from '@/routes';

// 2026-11-16(월) ~ 22(일) 주. 시드는 이 주 월요일 기준.
const API = () => createMemoryCalendarApi(seedCalendar('2026-11-18'));

function renderAt(path: string, api: CalendarApi = API()) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <SessionLoaderProvider value={async () => ({ shopId: 'shop-1' })}>
      <CalendarApiProvider value={api}>
        <RouterProvider router={router} />
      </CalendarApiProvider>
    </SessionLoaderProvider>,
  );
  return router;
}

const appt = (over: Partial<CalendarAppointment>): CalendarAppointment => ({
  id: 'x',
  customerName: '테스트',
  menuName: null,
  staffId: 's1',
  startAt: '2026-11-18T05:00:00Z', // 서울 14:00
  durationMin: 60,
  prepMin: 20,
  memo: null,
  status: 'scheduled',
  ...over,
});

describe('캘린더 배치 규칙', () => {
  it('주는 월요일부터 7일, 달력은 꽉 찬 주 단위', () => {
    expect(weekDays('2026-11-20')).toEqual([
      '2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22',
    ]);
    const m = monthGrid('2026-11-20');
    expect(m[0]).toBe('2026-10-26');
    expect(m.at(-1)).toBe('2026-12-06');
    expect(m.length % 7).toBe(0);
  });

  it('점유 = [시작 − 준비, 시작 + 관리): 14:00·관리 60분·준비 20분 → 준비 13:40~14:00, 관리 14:00~15:00', () => {
    const segs = segmentsForDay('2026-11-18', { appointments: [appt({})], blocks: [] });
    expect(segs).toEqual([
      { kind: 'prep', sourceId: 'x', fromMin: 13 * 60 + 40, toMin: 14 * 60, staffId: 's1' },
      { kind: 'care', sourceId: 'x', fromMin: 14 * 60, toMin: 15 * 60, staffId: 's1' },
    ]);
    expect(appointmentTimeText(appt({}))).toBe('13:40 준비 · 14:00–15:00');
    expect(appointmentTimeText(appt({ prepMin: 0 }))).toBe('14:00–15:00');
  });

  it('자정을 넘는 예약은 날마다 잘라 그린다', () => {
    const late = appt({ startAt: '2026-11-18T14:30:00Z', durationMin: 60, prepMin: 0 }); // 서울 23:30~00:30
    expect(segmentsForDay('2026-11-18', { appointments: [late], blocks: [] })).toMatchObject([{ fromMin: 1410, toMin: 1440 }]);
    expect(segmentsForDay('2026-11-19', { appointments: [late], blocks: [] })).toMatchObject([{ fromMin: 0, toMin: 30 }]);
  });

  it('취소·되돌림 예약은 그리지 않는다, 완료·노쇼는 그린다', () => {
    const segs = segmentsForDay('2026-11-18', {
      appointments: [
        appt({ id: 'c', status: 'cancelled' }),
        appt({ id: 'v', status: 'voided' }),
        appt({ id: 'd', status: 'completed', prepMin: 0 }),
        appt({ id: 'n', status: 'no_show', prepMin: 0 }),
      ],
      blocks: [],
    });
    expect(segs.map((s) => s.sourceId)).toEqual(['d', 'n']);
  });

  it('차단: 매장 전체는 줄 하나(null), 담당자 지정은 담당자마다', () => {
    const blocks = [
      { id: 'all', startAt: '2026-11-18T03:00:00Z', endAt: '2026-11-18T04:00:00Z', allStaff: true, staffIds: [], memo: null },
      { id: 'two', startAt: '2026-11-18T03:00:00Z', endAt: '2026-11-18T04:00:00Z', allStaff: false, staffIds: ['s1', 's2'], memo: null },
    ];
    const segs = segmentsForDay('2026-11-18', { appointments: [], blocks });
    expect(segs.map((s) => [s.sourceId, s.staffId])).toEqual([['all', null], ['two', 's1'], ['two', 's2']]);
  });

  it('세로 범위는 기본 9~21시, 밖의 조각이 있으면 넓힌다', () => {
    expect(hourRange([])).toEqual([9, 21]);
    expect(hourRange([{ kind: 'care', sourceId: 'a', fromMin: 8 * 60 + 30, toMin: 22 * 60 + 10, staffId: null }])).toEqual([8, 23]);
  });
});

describe('캘린더 화면', () => {
  it('주간 보기: 요일 7칸과 관리·준비·차단이 서로 다른 모양으로 보인다', async () => {
    renderAt('/calendar?date=2026-11-18');
    expect(await screen.findByRole('heading', { level: 2, name: '11월 16일 – 11월 22일' })).toBeInTheDocument();
    await screen.findByRole('region', { name: '11월 16일' });
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['월 16', '화 17', '수 18', '목 19', '금 20', '토 21', '일 22']);
    expect(screen.getByRole('button', { name: '주', pressed: true })).toBeInTheDocument();
    const kinds = new Set(Array.from(document.querySelectorAll('[data-kind]')).map((e) => e.getAttribute('data-kind')));
    expect(kinds).toEqual(new Set(['care', 'prep', 'block']));
  });

  it('예약 카드에 고객·메뉴·담당자가 보이고, 누르면 메모가 보인다', async () => {
    renderAt('/calendar?date=2026-11-18');
    const monday = await screen.findByRole('region', { name: '11월 16일' });
    const card = within(monday).getByRole('button', { name: /이서윤/ });
    expect(card).toHaveTextContent('이서윤등 관리원장');
    await userEvent.click(card);
    const dialog = await screen.findByRole('dialog', { name: '이서윤' });
    expect(dialog).toHaveTextContent('임산부 — 복부 관리 제외');
    expect(dialog).toHaveTextContent('2026-11-16 13:40 준비 · 14:00–15:00');
  });

  it('담당자가 2명이면 같은 시각 2건이 나란히 보인다(가짜 담당자는 이 테스트에서만)', async () => {
    const twoStaff = createMemoryCalendarApi({
      staff: [
        { id: 's1', name: '원장' },
        { id: 's2', name: '보조' },
      ],
      appointments: [
        appt({ id: 'p1', customerName: '손님가', staffId: 's1' }),
        appt({ id: 'p2', customerName: '손님나', staffId: 's2' }),
      ],
      blocks: [],
    });
    renderAt('/calendar?date=2026-11-18', twoStaff);
    const wed = await screen.findByRole('region', { name: '11월 18일' });
    const a = within(wed).getByRole('button', { name: /손님가/ });
    const b = within(wed).getByRole('button', { name: /손님나/ });
    expect(b).toHaveTextContent('보조');
    expect(a.style.top).toBe(b.style.top);
    expect(a.style.left).not.toBe(b.style.left);
  });

  it('담당자가 1명이면 예약 카드가 칸 전체 너비다', async () => {
    renderAt('/calendar?date=2026-11-18');
    const monday = await screen.findByRole('region', { name: '11월 16일' });
    const card = within(monday).getByRole('button', { name: /이서윤/ });
    expect(card.style.width).toBe('100%');
  });

  it('취소된 예약은 캘린더에 없다', async () => {
    renderAt('/calendar?date=2026-11-18');
    const thursday = await screen.findByRole('region', { name: '11월 19일' });
    expect(within(thursday).queryByRole('button')).not.toBeInTheDocument();
    expect(within(thursday).getByText('차단 · 점심')).toBeInTheDocument();
  });

  it('주 ↔ 월 전환과 이전·다음 이동은 주소에 남는다', async () => {
    const router = renderAt('/calendar?date=2026-11-18');
    await screen.findByRole('region', { name: '11월 16일' });
    await userEvent.click(screen.getByRole('button', { name: '월' }));
    expect(await screen.findByRole('heading', { level: 2, name: '2026년 11월' })).toBeInTheDocument();
    expect(router.state.location.search).toBe('?view=month&date=2026-11-18');
    const day = await screen.findByRole('region', { name: '11월 20일' });
    expect(within(day).getByRole('button', { name: /15:00 한예린/ })).toBeInTheDocument();
    expect(within(day).getByText('차단 · 원장 외출')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '다음 달' }));
    expect(await screen.findByRole('heading', { level: 2, name: '2026년 12월' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '주' }));
    expect(await screen.findByRole('heading', { level: 2, name: '11월 30일 – 12월 6일' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '이전 주' }));
    expect(await screen.findByRole('heading', { level: 2, name: '11월 23일 – 11월 29일' })).toBeInTheDocument();
  });

  it('주소의 날짜가 없는 날이면 오늘 기준으로 보여 준다', async () => {
    expect(validDate('2026-11-18')).toBe(true);
    expect(['2026-99-99', '2026-02-30', '2026-1-1', null].map(validDate)).toEqual([false, false, false, false]);
    renderAt('/calendar?date=2026-99-99');
    expect(await screen.findAllByRole('columnheader')).toHaveLength(7);
  });

  it('자정을 넘는 예약은 두 날 모두에 누를 수 있는 카드가 붙는다', async () => {
    const late = appt({ id: 'late', customerName: '심야손님', startAt: '2026-11-18T14:30:00Z', prepMin: 0 }); // 서울 수 23:30~목 00:30
    renderAt('/calendar?date=2026-11-18', createMemoryCalendarApi({ staff: [{ id: 's1', name: '원장' }], appointments: [late], blocks: [] }));
    for (const day of ['11월 18일', '11월 19일']) {
      const region = await screen.findByRole('region', { name: day });
      expect(within(region).getByRole('button', { name: /심야손님/ })).toBeInTheDocument();
    }
  });

  it('불러오기 실패는 경고와 다시 시도로 보인다', async () => {
    let fail = true;
    const ok = API();
    renderAt('/calendar?date=2026-11-18', { range: (f, t) => (fail ? Promise.reject(new Error('x')) : ok.range(f, t)) });
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: '다시 시도' }));
    expect(await screen.findByRole('region', { name: '11월 16일' })).toBeInTheDocument();
  });
});
