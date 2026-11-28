// 가짜 캘린더 저장소의 쓰기(예약 넣기·상태 바꾸기·관리 불가 넣기). 판정은 서버와 같은 @bv/scheduling 규칙(절대 규칙 4).
// rev.3.1: 겹침·차단·영업시간 밖·휴무는 거부하지 않고 warnings로 돌려준다(설계 12 §5-1).
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
  cleanupMin: 10,
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
  cleanupMin: 10,
  memo: null,
  ...over,
});

describe('가짜 캘린더 저장소 — 예약 넣기(createAppointment)', () => {
  it('비어 있는 시간이면 저장되고 range에 보인다', async () => {
    const api = createMemoryCalendarApi(seed());
    const r = await api.createAppointment(input({}));
    expect(r).toMatchObject({ ok: true, value: { customerName: '새손님', status: 'scheduled', warnings: [] } });
    const day = await api.range('2026-11-16', '2026-11-16');
    expect(day.appointments.map((a) => a.customerName)).toContain('새손님');
  });

  it('같은 담당자 예약과 겹쳐도 저장하고 OVERLAP_APPOINTMENT로 걸린 예약 id를 돌려준다 — 정리 시간만 겹쳐도', async () => {
    const api = createMemoryCalendarApi(seed());
    // a1 = 14:00~15:00 + 정리 10분 → 15:05 시작은 정리와만 겹친다
    const r = await api.createAppointment(input({ startAt: kst('2026-11-16', '15:05') }));
    expect(r).toMatchObject({ ok: true, value: { warnings: [{ code: 'OVERLAP_APPOINTMENT', relatedIds: ['a1'] }] } });
    expect((await api.range('2026-11-16', '2026-11-16')).appointments).toHaveLength(3);
    // 끝과 시작이 같으면(15:10) 겹치지 않는다
    expect(await api.createAppointment(input({ startAt: kst('2026-11-16', '15:10'), staffId: 's2' }))).toMatchObject({ value: { warnings: [] } });
  });

  it('담당자 미지정은 누구와도 겹친다', async () => {
    const api = createMemoryCalendarApi(seed());
    const r = await api.createAppointment(input({ staffId: null, startAt: kst('2026-11-16', '14:30') }));
    expect(r).toMatchObject({ ok: true, value: { staffId: null, warnings: [{ code: 'OVERLAP_APPOINTMENT', relatedIds: ['a1'] }] } });
  });

  it('영업시간 밖에서 끝나면 OUTSIDE_BUSINESS_HOURS, 휴무일이면 CLOSED_DAY — 둘 다 저장된다', async () => {
    const api = createMemoryCalendarApi(seed());
    expect(await api.createAppointment(input({ startAt: kst('2026-11-16', '19:30') }))).toMatchObject({
      ok: true,
      value: { warnings: [{ code: 'OUTSIDE_BUSINESS_HOURS', relatedIds: [] }] },
    });
    expect(await api.createAppointment(input({ startAt: kst('2026-11-18', '12:00') }))).toMatchObject({
      ok: true,
      value: { warnings: [{ code: 'CLOSED_DAY', relatedIds: [] }] },
    });
  });

  it('미리 보기는 저장과 같은 판정이고 아무것도 쓰지 않는다. 고치기 미리 보기는 자기 자신을 뺀다', async () => {
    const api = createMemoryCalendarApi(seed());
    const draft = { customerId: 'c1', staffId: 's1', startAt: kst('2026-11-16', '14:30'), durationMin: 60, cleanupMin: 10 };
    expect(await api.previewWarnings(draft)).toEqual([{ code: 'OVERLAP_APPOINTMENT', relatedIds: ['a1'] }]);
    expect((await api.range('2026-11-16', '2026-11-16')).appointments).toHaveLength(2);
    expect(await api.previewWarnings({ appointmentId: 'a1', version: 1, startAt: kst('2026-11-16', '14:30') })).toEqual([]);
  });

  it('담당자 필수 설정이 켜지면 미지정 새 예약·시간 변경은 STAFF_REQUIRED, 기존 미지정 예약의 메모 수정은 된다(설계 12 D3)', async () => {
    const withUnassigned = { ...seed(), appointments: [existing({ id: 'u1', staffId: null })] };
    const api = createMemoryCalendarApi(withUnassigned, [], { requireStaffSelection: true });
    expect(await api.appointmentRules()).toEqual({ requireStaffSelection: true });
    expect(await api.createAppointment(input({ staffId: null }))).toEqual({ ok: false, reason: 'STAFF_REQUIRED' });
    expect(await api.updateAppointment('u1', { version: 1, memo: '메모만' })).toMatchObject({ ok: true, value: { memo: '메모만' } });
    expect(await api.updateAppointment('u1', { version: 2, durationMin: 90 })).toEqual({ ok: false, reason: 'STAFF_REQUIRED' });
  });
});

describe('가짜 캘린더 저장소 — 상태 바꾸기(setStatus)', () => {
  it('예정 → 완료는 바뀐다', async () => {
    const api = createMemoryCalendarApi(seed());
    expect(await api.setStatus('a1', 'completed')).toMatchObject({ ok: true, value: { id: 'a1', status: 'completed' } });
  });

  it('취소를 예정으로 되살릴 때 같은 담당자 예약과 겹쳐도 되살리고 경고를 돌려준다', async () => {
    const api = createMemoryCalendarApi(seed());
    expect(await api.setStatus('a2', 'scheduled')).toMatchObject({
      ok: true,
      value: { status: 'scheduled', warnings: [{ code: 'OVERLAP_APPOINTMENT', relatedIds: ['a1'] }] },
    });
  });

  it('없는 예약이면 오류', async () => {
    const api = createMemoryCalendarApi(seed());
    await expect(api.setStatus('none', 'completed')).rejects.toThrow('APPOINTMENT_NOT_FOUND');
  });
});

describe('가짜 캘린더 저장소 — 관리 불가 넣기(createBlock)', () => {
  it('넣으면 range에 보이고, 그 시간의 새 예약은 OVERLAP_BLOCK 경고와 함께 저장. 기존 예약은 그대로(결정 R50)', async () => {
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
    expect(await api.createAppointment(input({}))).toMatchObject({ ok: true, value: { warnings: [{ code: 'OVERLAP_BLOCK', relatedIds: [b.id] }] } });
  });

  it('끝이 시작보다 빠르거나 같으면 오류', async () => {
    const api = createMemoryCalendarApi(seed());
    const t = kst('2026-11-16', '13:00');
    await expect(api.createBlock({ startAt: t, endAt: t, allStaff: true, staffIds: [], memo: null })).rejects.toThrow('INVALID_PERIOD');
  });
});
