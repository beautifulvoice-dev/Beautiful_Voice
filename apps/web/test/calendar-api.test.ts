// 가짜 캘린더 저장소의 쓰기(예약 넣기·상태 바꾸기·관리 불가 넣기). 검사는 서버와 같은 @bv/scheduling 규칙(절대 규칙 4).
// 합성 데이터만 쓴다. 시각은 서울(+9) 기준 — 2026-11-16(월) 14:00 = 05:00Z.
import { describe, expect, it } from 'vitest';
import { createMemoryCalendarApi, type CalendarSeed, type NewAppointment } from '@/features/calendar/api';
import type { CalendarAppointment } from '@/features/calendar/model';

const kst = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00+09:00`).toISOString();

const existing = (over: Partial<CalendarAppointment>): CalendarAppointment => ({
  id: 'a1',
  customerName: '손님가',
  menuName: '등 관리',
  staffId: 's1',
  startAt: kst('2026-11-16', '14:00'),
  durationMin: 60,
  prepMin: 10,
  memo: null,
  status: 'scheduled',
  ...over,
});

/** 원장 1명, 월~일 10~20시 영업, 수요일 정기 휴무. 월 14:00 예정 1건 + 같은 자리 취소 1건. */
const seed = (): CalendarSeed => ({
  staff: [{ id: 's1', name: '원장' }],
  appointments: [existing({}), existing({ id: 'a2', customerName: '손님나', status: 'cancelled' })],
  blocks: [],
  businessHours: Object.fromEntries(['1', '2', '3', '4', '5', '6', '7'].map((k) => [k, [{ open: '10:00', close: '20:00' }]])),
  closures: [{ id: 'c1', kind: 'weekly', weekday: 3, note: '정기 휴무' }],
});

const input = (over: Partial<NewAppointment>): NewAppointment => ({
  customerId: null,
  customerName: '새손님',
  customerPhone: null,
  menuName: '수분 관리',
  staffId: 's1',
  startAt: kst('2026-11-16', '16:00'),
  durationMin: 60,
  prepMin: 10,
  memo: null,
  ...over,
});

describe('가짜 캘린더 저장소 — 예약 넣기(createAppointment)', () => {
  it('비어 있는 시간이면 저장되고 range에 보인다', async () => {
    const api = createMemoryCalendarApi(seed());
    const r = await api.createAppointment(input({}));
    expect(r).toMatchObject({ ok: true, value: { customerName: '새손님', status: 'scheduled' } });
    const day = await api.range('2026-11-16', '2026-11-16');
    expect(day.appointments.map((a) => a.customerName)).toContain('새손님');
  });

  it('같은 담당자 예약과 겹치면 STAFF_OVERLAP, 걸린 예약 id를 돌려주고 저장하지 않는다', async () => {
    const api = createMemoryCalendarApi(seed());
    const r = await api.createAppointment(input({ startAt: kst('2026-11-16', '14:30') }));
    expect(r).toEqual({ ok: false, reason: 'STAFF_OVERLAP', conflictingIds: ['a1'] });
    expect((await api.range('2026-11-16', '2026-11-16')).appointments).toHaveLength(2);
  });

  it('영업시간 밖에서 끝나면 OUTSIDE_BUSINESS_HOURS, 휴무일이면 CLOSED_DAY', async () => {
    const api = createMemoryCalendarApi(seed());
    expect(await api.createAppointment(input({ startAt: kst('2026-11-16', '19:30') }))).toMatchObject({
      ok: false,
      reason: 'OUTSIDE_BUSINESS_HOURS',
    });
    expect(await api.createAppointment(input({ startAt: kst('2026-11-18', '12:00') }))).toMatchObject({ ok: false, reason: 'CLOSED_DAY' });
  });
});

describe('가짜 캘린더 저장소 — 상태 바꾸기(setStatus)', () => {
  it('예정 → 완료는 바뀐다', async () => {
    const api = createMemoryCalendarApi(seed());
    expect(await api.setStatus('a1', 'completed')).toMatchObject({ ok: true, value: { id: 'a1', status: 'completed' } });
  });

  it('취소를 예정으로 되살릴 때 같은 담당자 예약과 겹치면 거부하고 상태는 그대로', async () => {
    const api = createMemoryCalendarApi(seed());
    expect(await api.setStatus('a2', 'scheduled')).toEqual({ ok: false, reason: 'STAFF_OVERLAP', conflictingIds: ['a1'] });
    const a2 = (await api.range('2026-11-16', '2026-11-16')).appointments.find((a) => a.id === 'a2');
    expect(a2?.status).toBe('cancelled');
  });

  it('없는 예약이면 오류', async () => {
    const api = createMemoryCalendarApi(seed());
    await expect(api.setStatus('none', 'completed')).rejects.toThrow('APPOINTMENT_NOT_FOUND');
  });
});

describe('가짜 캘린더 저장소 — 관리 불가 넣기(createBlock)', () => {
  it('넣으면 range에 보이고, 그 시간의 새 예약은 BLOCKED. 기존 예약은 그대로(결정 R50)', async () => {
    const api = createMemoryCalendarApi(seed());
    const b = await api.createBlock({
      startAt: kst('2026-11-16', '13:00'),
      endAt: kst('2026-11-16', '17:00'),
      allStaff: true,
      staffIds: [],
      memo: '외출',
    });
    const day = await api.range('2026-11-16', '2026-11-16');
    expect(day.blocks.map((x) => x.id)).toEqual([b.id]);
    expect(day.appointments.find((a) => a.id === 'a1')?.status).toBe('scheduled');
    expect(await api.createAppointment(input({}))).toEqual({ ok: false, reason: 'BLOCKED', conflictingIds: [b.id] });
  });

  it('끝이 시작보다 빠르거나 같으면 오류', async () => {
    const api = createMemoryCalendarApi(seed());
    const t = kst('2026-11-16', '13:00');
    await expect(api.createBlock({ startAt: t, endAt: t, allStaff: true, staffIds: [], memo: null })).rejects.toThrow('INVALID_PERIOD');
  });
});
