// 캘린더 창구의 실제 API 구현(#42 calendar·appointments·status, 서버 #55·#71). 화면은 CalendarApi만 안다.
// - 조회: 캘린더(예약·담당자·차단)와 설정(영업시간·휴무)을 함께 읽는다. 설정만 실패하면 예약은 보이고 음영만 보류(설계 05 D3).
// - 취소·무효는 그대로 받고 화면이 뺀다(04 D6). 화면에 남는 예약이 없는 비활성 담당자는 열을 만들지 않는다(04 D7).
// - 상태 바꾸기는 마지막으로 읽은(또는 방금 저장한) version을 보낸다 → 스낵바 되돌리기도 방금 저장한 version으로(04 §W2).
import type { Appointment, BusinessHoursBody, CalendarResponse, Closure, Menu as ContractMenu } from '@bv/contracts';
import type { BookingReject } from '@bv/scheduling/booking';
import { randomKey } from '@/features/settings/useSaveAction';
import { HttpError, NetworkError, shopPath, type Http } from '@/lib/http';
import type { CalendarApi, SaveReject, SaveResult } from './api';
import { isShown, type CalendarAppointment, type Menu } from './model';

/** 메뉴에 시간을 안 정했을 때 W3가 쓰는 기본값(설계 06 D3). ASSUMPTION: W3 실제 연결(06) 전까지 창구에서 채운다. */
const DEFAULT_DURATION_MIN = 60;
const DEFAULT_PREP_MIN = 10;

const REJECTS: readonly string[] = [
  'STAFF_OVERLAP', 'BLOCKED', 'OUTSIDE_BUSINESS_HOURS', 'CLOSED_DAY', 'INVALID_TRANSITION', 'NO_CHANGE', 'VERSION_CONFLICT', 'NOT_FOUND',
] satisfies (BookingReject | SaveReject)[];

const toAppointment = (a: Appointment): CalendarAppointment => ({
  id: a.id,
  customerId: a.customerId,
  customerName: a.customerName,
  menuId: a.menuId ?? null,
  menuName: a.menuName,
  staffId: a.staffId,
  startAt: a.startAt,
  durationMin: a.durationMin,
  prepMin: a.prepMin ?? 0,
  memo: a.memo ?? null,
  status: a.status,
  version: a.version,
});

/**
 * 서버 거절 → 저장 결과. 던지지 않는다 — 화면(W2·W3)이 저장 중 상태에서 멈추지 않게(#73 리뷰).
 * 응답을 못 받으면 NETWORK, 로그인 만료는 UNAUTHENTICATED, 그 밖(500 등)은 FAILED(다시 시도할 수 있음).
 */
function toReject(err: unknown): SaveResult<never> {
  if (err instanceof NetworkError) return { ok: false, reason: 'NETWORK', conflictingIds: [] };
  if (err instanceof HttpError && REJECTS.includes(err.code)) {
    const ids = err.details.conflictingIds;
    return { ok: false, reason: err.code as SaveReject, conflictingIds: Array.isArray(ids) ? (ids as string[]) : [] };
  }
  if (err instanceof HttpError && err.status === 401) return { ok: false, reason: 'UNAUTHENTICATED', conflictingIds: [] };
  return { ok: false, reason: 'FAILED', conflictingIds: [] };
}

export function createHttpCalendarApi(http: Http, shopId: string): CalendarApi {
  const path = (...s: string[]) => shopPath(shopId, ...s);
  /** 예약 id → 마지막으로 본 version. */
  const versions = new Map<string, number>();
  const remember = (a: CalendarAppointment) => {
    if (a.version !== undefined) versions.set(a.id, a.version);
    return a;
  };
  /** 같은 상태 요청(id·목표·version)을 응답 없이 다시 보내면 같은 키(설계 05 D5). */
  const statusKeys = new Map<string, string>();

  return {
    async range(from, to) {
      const settings = Promise.all([
        http.get<BusinessHoursBody>(path('settings', 'business-hours')),
        http.get<{ items: Closure[] }>(path('closures')),
      ]).catch(() => null);
      const [calendar, hours] = await Promise.all([http.get<CalendarResponse>(path('calendar'), { query: { from, to } }), settings]);
      const appointments = calendar.appointments.map(toAppointment).map(remember);
      const shownStaff = new Set(appointments.filter(isShown).map((a) => a.staffId));
      return {
        staff: calendar.staff.filter((s) => s.active || shownStaff.has(s.id)).map((s) => ({ id: s.id, name: s.name, active: s.active })),
        appointments,
        // 차단은 BEA-179 전까지 빈 배열(#42).
        blocks: calendar.blocks.map((b) => ({ id: b.id, startAt: b.startAt, endAt: b.endAt, allStaff: b.allStaff, staffIds: b.staffIds, memo: b.memo ?? null })),
        businessHours: hours?.[0].businessHours ?? null,
        closures: hours ? hours[1].items : [],
        ...(hours ? {} : { hoursUnavailable: true }),
      };
    },
    async menus(): Promise<Menu[]> {
      const { items } = await http.get<{ items: ContractMenu[] }>(path('menus'));
      return items.map((m) => ({
        id: m.id,
        name: m.name,
        durationMin: m.defaultDurationMin ?? DEFAULT_DURATION_MIN,
        prepMin: m.defaultPrepMin ?? DEFAULT_PREP_MIN,
      }));
    },
    async createAppointment(input, options) {
      // 고객은 먼저 등록한다(설계 06 D2) — 이 창구는 고객을 만들지 않는다.
      if (!input.customerId) throw new Error('CUSTOMER_REQUIRED');
      try {
        const created = await http.send<Appointment>('POST', path('appointments'), {
          body: {
            customerId: input.customerId,
            staffId: input.staffId,
            menuId: input.menuId ?? null,
            startAt: input.startAt,
            durationMin: input.durationMin,
            prepMin: input.prepMin,
            memo: input.memo,
          },
          idempotencyKey: options?.idempotencyKey ?? randomKey(),
        });
        return { ok: true, value: remember(toAppointment(created)) };
      } catch (err) {
        return toReject(err);
      }
    },
    async setStatus(id, to) {
      let version = versions.get(id);
      if (version === undefined) {
        try {
          version = remember(toAppointment(await http.get<Appointment>(path('appointments', id)))).version!;
        } catch (err) {
          return toReject(err);
        }
      }
      const request = `${id}|${to}|${version}`;
      const idempotencyKey = statusKeys.get(request) ?? randomKey();
      statusKeys.set(request, idempotencyKey);
      try {
        const saved = await http.send<Appointment>('PUT', path('appointments', id, 'status'), { body: { version, status: to }, idempotencyKey });
        statusKeys.delete(request);
        return { ok: true, value: remember(toAppointment(saved)) };
      } catch (err) {
        if (!(err instanceof NetworkError)) statusKeys.delete(request);
        return toReject(err);
      }
    },
    async createBlock() {
      // 차단 API는 BEA-179에서 생긴다(#42 — 11/25 시연 범위 밖).
      throw new Error('BLOCKS_NOT_AVAILABLE');
    },
  };
}
