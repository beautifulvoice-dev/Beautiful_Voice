// 캘린더 창구의 실제 API 구현(#42 calendar·appointments·status, 서버 #55·#71). 화면은 CalendarApi만 안다.
// - 조회: 캘린더(예약·담당자·차단)와 설정(영업시간·휴무)을 함께 읽는다. 설정만 실패하면 예약은 보이고 음영만 보류(설계 05 D3).
// - 취소·무효는 그대로 받고 화면이 뺀다(04 D6). 화면에 남는 예약이 없는 비활성 담당자는 열을 만들지 않는다(04 D7).
// - 상태 바꾸기는 마지막으로 읽은(또는 방금 저장한) version을 보낸다 → 스낵바 되돌리기도 방금 저장한 version으로(04 §W2).
// - 관리 불가 시간(BEA-179 서버 #84): 넣기·지우기. 예약의 겹침은 서버가 준 blockedBy·overlappingAppointmentIds를 쓴다(설계 09 D5·12 §3).
// - rev.3.1: 예약 쓰기는 겹쳐도 저장되고 응답에 warnings가 온다. 정리 시간은 새 이름 cleanupMin으로만 보낸다.
import type {
  Appointment,
  AppointmentPreviewResponse,
  AppointmentRules,
  AppointmentSaved,
  BusinessHoursBody,
  CalendarBlock as ContractBlock,
  CalendarResponse,
  Closure,
  Menu as ContractMenu,
} from '@bv/contracts';
import { randomKey } from '@/features/settings/useSaveAction';
import { HttpError, NetworkError, shopPath, type Http } from '@/lib/http';
import type { CalendarApi, SavedAppointment, SaveReject, SaveResult } from './api';
import { isShown, type CalendarAppointment, type CalendarBlock, type Menu } from './model';

const REJECTS: readonly string[] = ['INVALID_TRANSITION', 'NO_CHANGE', 'VERSION_CONFLICT', 'NOT_FOUND'] satisfies SaveReject[];

const toAppointment = (a: Appointment): CalendarAppointment => ({
  id: a.id,
  customerId: a.customerId,
  customerName: a.customerName,
  menuId: a.menuId ?? null,
  menuName: a.menuName,
  staffId: a.staffId ?? null,
  startAt: a.startAt,
  durationMin: a.durationMin,
  // 서버 ②는 전환 기간에 옛 이름도 함께 준다 — 새 이름이 없으면(② 전 서버) 옛 값을 쓴다.
  cleanupMin: a.cleanupMin ?? a.prepMin ?? 0,
  memo: a.memo ?? null,
  status: a.status,
  version: a.version,
  blockedBy: a.blockedBy ?? [],
  overlappingAppointmentIds: a.overlappingAppointmentIds ?? [],
});
const toSaved = (a: AppointmentSaved): SavedAppointment => ({ ...toAppointment(a), warnings: a.warnings ?? [] });

const toBlock = (b: ContractBlock): CalendarBlock => ({
  id: b.id, startAt: b.startAt, endAt: b.endAt, allStaff: b.allStaff, staffIds: b.staffIds, memo: b.memo ?? null, version: b.version,
});

/**
 * 서버 거절 → 저장 결과. 던지지 않는다 — 화면(W2·W3)이 저장 중 상태에서 멈추지 않게(#73 리뷰).
 * 응답을 못 받으면 NETWORK, 로그인 만료는 UNAUTHENTICATED, 그 밖(500 등)은 FAILED(다시 시도할 수 있음).
 */
function toReject(err: unknown): SaveResult<never> {
  const fail = (reason: SaveReject): SaveResult<never> => ({ ok: false, reason });
  if (err instanceof NetworkError) return fail('NETWORK');
  if (err instanceof HttpError && REJECTS.includes(err.code)) return fail(err.code as SaveReject);
  if (err instanceof HttpError && err.code === 'VALIDATION_FAILED') {
    const fields = Array.isArray(err.details.fields) ? (err.details.fields as { field?: string; code?: string }[]) : [];
    return fail(fields.some((f) => f.field === 'staffId' && f.code === 'REQUIRED') ? 'STAFF_REQUIRED' : 'INVALID_INPUT');
  }
  if (err instanceof HttpError && err.status === 401) return fail('UNAUTHENTICATED');
  return fail('FAILED');
}

/** 화면 표시용 칸 — 바꾸기 요청에 싣지 않는다. */
const DISPLAY_ONLY = new Set(['customerName', 'customerPhone', 'menuName']);

export function createHttpCalendarApi(http: Http, shopId: string): CalendarApi {
  const path = (...s: string[]) => shopPath(shopId, ...s);
  /** 예약 id → 마지막으로 본 version. */
  const versions = new Map<string, number>();
  const remember = <T extends CalendarAppointment>(a: T): T => {
    if (a.version !== undefined) versions.set(a.id, a.version);
    return a;
  };
  /** 같은 상태 요청(id·목표·version)을 응답 없이 다시 보내면 같은 키(설계 05 D5). */
  const statusKeys = new Map<string, string>();

  return {
    persistsAppointments: true,
    supportsBlocks: true,
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
        // 활성 차단(BEA-179). 숨긴 담당자에게만 걸린 차단은 그 담당자 열이 없으면 보이지 않는다(04 D7과 같은 기준).
        blocks: calendar.blocks.map(toBlock),
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
        // 안 정한 시간은 null 그대로 — W3가 지금 입력을 둔다(설계 06 D3).
        durationMin: m.defaultDurationMin,
        cleanupMin: m.defaultCleanupMin ?? m.defaultPrepMin ?? null,
      }));
    },
    async appointmentRules() {
      const r = await http.get<AppointmentRules>(path('settings', 'appointment-rules'));
      return { requireStaffSelection: r.requireStaffSelection };
    },
    async previewWarnings(input) {
      // 읽기 전용이라 Idempotency-Key 없이 보낸다(계약 preview-warnings).
      const r = await http.send<AppointmentPreviewResponse>('POST', path('appointments', 'preview-warnings'), { body: input });
      return r.warnings;
    },
    async createAppointment(input, options) {
      // 고객은 먼저 등록한다(설계 06 D2) — 이 창구는 고객을 만들지 않는다.
      if (!input.customerId) throw new Error('CUSTOMER_REQUIRED');
      try {
        const created = await http.send<AppointmentSaved>('POST', path('appointments'), {
          body: {
            customerId: input.customerId,
            staffId: input.staffId,
            menuId: input.menuId ?? null,
            startAt: input.startAt,
            durationMin: input.durationMin,
            cleanupMin: input.cleanupMin,
            memo: input.memo,
          },
          idempotencyKey: options?.idempotencyKey ?? randomKey(),
        });
        return { ok: true, value: remember(toSaved(created)) };
      } catch (err) {
        return toReject(err);
      }
    },
    async appointment(id) {
      try {
        return remember(toAppointment(await http.get<Appointment>(path('appointments', id))));
      } catch (err) {
        if (err instanceof HttpError && err.status === 404) return null;
        throw err;
      }
    },
    async updateAppointment(id, change, options) {
      // 화면 표시용 이름 칸은 보내지 않는다 — 계약에 없는 칸은 서버가 거부한다(UNKNOWN_FIELD).
      const body = Object.fromEntries(Object.entries(change).filter(([k]) => !DISPLAY_ONLY.has(k)));
      try {
        const saved = await http.send<AppointmentSaved>('PATCH', path('appointments', id), { body, idempotencyKey: options?.idempotencyKey ?? randomKey() });
        return { ok: true, value: remember(toSaved(saved)) };
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
        const saved = await http.send<AppointmentSaved>('PUT', path('appointments', id, 'status'), { body: { version, status: to }, idempotencyKey });
        statusKeys.delete(request);
        return { ok: true, value: remember(toSaved(saved)) };
      } catch (err) {
        if (!(err instanceof NetworkError)) statusKeys.delete(request);
        return toReject(err);
      }
    },
    async createBlock(input, options) {
      const b = await http.send<ContractBlock>('POST', path('calendar-blocks'), {
        body: { startAt: input.startAt, endAt: input.endAt, allStaff: input.allStaff, staffIds: input.allStaff ? [] : input.staffIds, memo: input.memo },
        idempotencyKey: options?.idempotencyKey ?? randomKey(),
      });
      return toBlock(b);
    },
    async removeBlock(id, version, options) {
      if (version === undefined) return { ok: false, reason: 'VERSION_CONFLICT' };
      try {
        await http.send<void>('DELETE', path('calendar-blocks', id), { query: { version }, idempotencyKey: options?.idempotencyKey ?? randomKey() });
        return { ok: true, value: null };
      } catch (err) {
        return toReject(err);
      }
    },
  };
}
