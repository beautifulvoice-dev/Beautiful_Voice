// 캘린더 화면이 데이터를 가져오고 쓰는 창구. 화면은 이 인터페이스만 알고, 예약 API(BEA-176)·설정 API(#45)가 생기면 구현만 바꾼다.
// 경고 판정은 서버와 같은 @bv/scheduling 규칙(appointmentWarnings·changeStatus)을 쓴다 — 웹·음성 같은 규칙(절대 규칙 4).
// rev.3.1: 웹 수동 저장은 겹침·차단·영업시간 밖·휴무를 거부하지 않고 경고(warnings)와 함께 저장한다(설계 12 §5-1).
import type { BookingWarning } from '@bv/contracts';
import { changeStatus } from '@bv/scheduling/appointment-status';
import type { ActiveBlock, ShopHours } from '@bv/scheduling/booking';
import { appointmentWarnings, occupancyOf, type OccupyingAppointment } from '@bv/scheduling/warnings';
import { createContext, useContext, useMemo } from 'react';
import { useOptionalSession } from '@/features/auth/session';
import { FAKE_API } from '@/lib/apiMode';
import { http } from '@/lib/http';
import { createHttpCalendarApi } from './httpApi';
import { seedDesignScene, SCENE_MENUS } from './mockData';
import { dayStart, type AppointmentStatus, type CalendarAppointment, type CalendarBlock, type CalendarData, type Menu } from './model';

/** 가짜 저장소에 넣는 값. 영업시간·휴무를 빼면 "안 넣은 매장"으로 본다. */
export type CalendarSeed = Omit<CalendarData, 'businessHours' | 'closures' | 'hoursUnavailable'> &
  Partial<Pick<CalendarData, 'businessHours' | 'closures'>>;

/** 예약 넣기(W3) 입력. 시각은 UTC ISO. */
export interface NewAppointment {
  customerId: string | null;
  customerName: string;
  customerPhone: string | null;
  menuName: string | null;
  /** null = 담당자 미지정. */
  staffId: string | null;
  startAt: string;
  durationMin: number;
  cleanupMin: number;
  memo: string | null;
  /** 실제 API는 메뉴를 id로 저장한다(계약 #42). 가짜 저장소는 이름만 쓴다. */
  menuId?: string | null;
}

/**
 * 예약 바꾸기(W2 바꾸기 → W3 편집) 입력. 읽은 version과 바뀐 칸만 보낸다(계약 #42 PATCH).
 * 이름 칸(customerName·customerPhone·menuName)은 가짜 저장소의 카드 표시용 — 실제 API는 보내지 않는다.
 */
export type AppointmentChange = Partial<
  Pick<CalendarAppointment, 'customerId' | 'customerName' | 'customerPhone' | 'menuId' | 'menuName' | 'staffId' | 'startAt' | 'durationMin' | 'cleanupMin' | 'memo'>
> & { version: number };

/** 관리 불가 시간 넣기(W4) 입력. */
export type NewBlock = Omit<CalendarBlock, 'id'>;

/** 미리 보기 요청: 새 예약 입력, 또는 고치는 예약 id·version + 바꿀 칸(계약 preview-warnings). */
export type WarningPreview =
  /** 새 예약. 고객은 선택(옵마 11/27 — 새 고객 입력 중·고객 미선택에도 미리 본다). */
  | { appointmentId?: undefined; customerId?: string; staffId: string | null; startAt: string; durationMin: number; cleanupMin: number }
  | ({ appointmentId: string; version: number } & Partial<Pick<NewAppointment, 'staffId' | 'startAt' | 'durationMin' | 'cleanupMin'>>);

/** 저장된 예약 + 그 저장 시점의 경고(rev.3.1 — 없으면 []). */
export type SavedAppointment = CalendarAppointment & { warnings: BookingWarning[] };

/**
 * 저장이 안 된 이유. 계약의 상태·동시 수정·담당자 필수 오류 + 응답을 못 받음(NETWORK).
 * 겹침·차단·영업시간·휴무는 rev.3.1부터 거부가 아니라 경고다.
 * NETWORK는 저장됐는지 모른다 — 같은 내용으로 다시 보내면 같은 키라 두 번 저장되지 않는다(설계 05 D5).
 */
export type SaveReject =
  /** 담당자 필수 설정이 켜졌는데 미지정(422 staffId REQUIRED). */
  | 'STAFF_REQUIRED'
  /** 그 밖의 입력 오류(422 VALIDATION_FAILED) — 숨긴 고객·메뉴·담당자, 범위 밖 분 등. */
  | 'INVALID_INPUT'
  | 'INVALID_TRANSITION'
  | 'NO_CHANGE'
  | 'VERSION_CONFLICT'
  | 'NOT_FOUND'
  | 'NETWORK'
  /** 로그인 만료(401) — 다시 로그인해야 한다. */
  | 'UNAUTHENTICATED'
  /** 그 밖의 서버 오류(500 등). 저장되지 않았다 — 다시 시도할 수 있다. */
  | 'FAILED';

/** 저장 결과. 거부면 이유(문구에 쓴다, W3 거부 표). */
export type SaveResult<T> = { ok: true; value: T } | { ok: false; reason: SaveReject };

/** 쓰기 옵션. 실제 API는 Idempotency-Key로 보낸다(절대 규칙 6). 비우면 창구가 만든다. */
export interface CalendarWriteOptions {
  idempotencyKey?: string;
}

export interface CalendarApi {
  /** 실제 예약 저장 API가 연결됐을 때만 true. */
  readonly persistsAppointments?: true;
  /** 관리 불가 시간(W4)을 넣고 지울 수 있는가. 실제 API(BEA-179 서버)와 가짜 저장소 모두 true. */
  readonly supportsBlocks?: true;
  /** 매장 날짜 from ~ to(마지막 날 포함). 즉 from 0시 ~ to 다음 날 0시 사이에 점유·차단이 걸치는 것. 예약 API 계약도 같은 뜻으로 둔다. */
  range(from: string, to: string): Promise<CalendarData>;
  menus(): Promise<Menu[]>;
  /** 예약 규칙(settings/appointment-rules). 켜면 새 예약·시간·담당자 변경에 담당자 필수. */
  appointmentRules(): Promise<{ requireStaffSelection: boolean }>;
  /** 저장 전 경고 미리 보기(읽기 전용). 실패는 던진다 — 화면은 미리 보기 없이도 저장할 수 있다. */
  previewWarnings(input: WarningPreview): Promise<BookingWarning[]>;
  createAppointment(input: NewAppointment, options?: CalendarWriteOptions): Promise<SaveResult<SavedAppointment>>;
  /** 예약 한 건의 최신 상세(바꾸기 전에 version을 받는다). 없으면 null. */
  appointment(id: string): Promise<CalendarAppointment | null>;
  /** 예약 바꾸기. 시간·담당자가 바뀌면 서버가 겹침·영업시간을 다시 본다(04 Q1·D2). */
  updateAppointment(id: string, change: AppointmentChange, options?: CalendarWriteOptions): Promise<SaveResult<SavedAppointment>>;
  /** 상태 바꾸기·고치기(W2, 결정 S5). 취소를 되살리면 겹침을 다시 판정해 경고로 돌려준다. */
  setStatus(id: string, to: AppointmentStatus): Promise<SaveResult<SavedAppointment>>;
  /** 관리 불가 시간은 기존 예약을 막지 않는다(결정 R50). start < end만 검사. 실패는 던진다(NetworkError면 같은 키로 다시). */
  createBlock(input: NewBlock, options?: CalendarWriteOptions): Promise<CalendarBlock>;
  /** 관리 불가 시간 지우기(#42 DELETE ?version, 설계 09 D3). 결과를 돌려준다 — 화면이 저장 중에서 멈추지 않게. */
  removeBlock(id: string, version: number | undefined, options?: CalendarWriteOptions): Promise<SaveResult<null>>;
}

/** 캘린더 데이터 → @bv/scheduling 경고 판정 입력. */
export function toWarningInputs(data: Pick<CalendarData, 'appointments' | 'blocks' | 'businessHours' | 'closures'>): {
  hours: ShopHours;
  existing: OccupyingAppointment[];
  blocks: ActiveBlock[];
} {
  return {
    // 계약(#42)의 영업시간 키는 '1'~'7' 문자열, 검사 함수는 1~7 — 자바스크립트 객체 키는 같은 문자열이다.
    hours: { businessHours: data.businessHours as ShopHours['businessHours'], closures: data.closures as ShopHours['closures'] },
    existing: data.appointments.map((a) => ({
      id: a.id,
      staffId: a.staffId,
      status: a.status,
      occupied: occupancyOf({ start: new Date(a.startAt), durationMin: a.durationMin, cleanupMin: a.cleanupMin }),
    })),
    blocks: data.blocks.map((b) => ({
      id: b.id,
      start: new Date(b.startAt),
      end: new Date(b.endAt),
      allStaff: b.allStaff,
      staffIds: b.staffIds,
    })),
  };
}

/**
 * 서버 API 전 임시 저장소(브라우저 메모리). 새로고침하면 처음 값으로 돌아간다.
 * ASSUMPTION: 한 매장 데이터만 담는다. 매장 격리(shop_id)는 실제 API가 로그인 정보로 보장한다.
 */
export function createMemoryCalendarApi(
  seed: CalendarSeed = seedDesignScene(),
  menus: readonly Menu[] = SCENE_MENUS,
  rules: { requireStaffSelection: boolean } = { requireStaffSelection: false },
): CalendarApi {
  const store = {
    staff: seed.staff.map((s) => ({ ...s })),
    appointments: seed.appointments.map((a) => ({ ...a })),
    blocks: seed.blocks.map((b) => ({ ...b, staffIds: [...b.staffIds] })),
    businessHours: seed.businessHours ?? null,
    closures: (seed.closures ?? []).map((c) => ({ ...c })),
  };
  let next = 1;
  /** 서버와 같은 경고 판정(설계 12 D4). 겹침에서 자기 자신은 뺀다. */
  const judge = (
    a: Pick<CalendarAppointment, 'staffId' | 'startAt' | 'durationMin' | 'cleanupMin'>,
    excludeId?: string,
    skipHoursCheck = false,
  ) => {
    const { hours, existing, blocks } = toWarningInputs(store);
    return appointmentWarnings(
      { staffId: a.staffId, start: new Date(a.startAt), durationMin: a.durationMin, cleanupMin: a.cleanupMin },
      hours,
      existing,
      blocks,
      { excludeId, skipHoursCheck },
    );
  };
  const staffMissing = (staffId: string | null) => rules.requireStaffSelection && staffId === null;
  const reject = (reason: SaveReject): SaveResult<never> => ({ ok: false, reason });
  const end = (x: Pick<CalendarAppointment, 'startAt' | 'durationMin'>) => Date.parse(x.startAt) + x.durationMin * 60_000;
  /** 고치기에서 다시 볼 것(서버 planUpdate와 같은 범위, 04 Q1·D2): 시작·끝이 바뀌면 영업시간까지, 정리·담당자만이면 겹침만. */
  const editScope = (before: CalendarAppointment, after: CalendarAppointment) => {
    const moved = after.startAt !== before.startAt || end(after) !== end(before);
    const timing = moved || after.cleanupMin !== before.cleanupMin || after.staffId !== before.staffId;
    return { moved, timing };
  };
  const OCCUPYING = new Set<AppointmentStatus>(['scheduled', 'completed', 'no_show']);

  return {
    supportsBlocks: true,
    async range(from, to) {
      const f = dayStart(from);
      const t = dayStart(to) + 86_400_000;
      const hit = (s: number, e: number) => s < t && e > f;
      return {
        staff: store.staff.map((s) => ({ ...s })),
        appointments: store.appointments
          .filter((a) => {
            const start = Date.parse(a.startAt);
            return hit(start, start + (a.durationMin + a.cleanupMin) * 60_000);
          })
          .map((a) => ({ ...a })),
        blocks: store.blocks.filter((b) => hit(Date.parse(b.startAt), Date.parse(b.endAt))).map((b) => ({ ...b })),
        businessHours: store.businessHours,
        closures: store.closures.map((c) => ({ ...c })),
      };
    },
    async menus() {
      return menus.map((m) => ({ ...m }));
    },
    async appointmentRules() {
      return { ...rules };
    },
    async previewWarnings(input) {
      if (input.appointmentId === undefined) return judge(input);
      const a = store.appointments.find((x) => x.id === input.appointmentId);
      if (!a) throw new Error('APPOINTMENT_NOT_FOUND');
      const after = {
        ...a,
        ...Object.fromEntries(Object.entries(input).filter(([k]) => k !== 'appointmentId' && k !== 'version')),
      } as CalendarAppointment;
      const { moved, timing } = editScope(a, after);
      return timing && OCCUPYING.has(a.status) ? judge(after, a.id, !moved) : [];
    },
    async createAppointment(input) {
      if (staffMissing(input.staffId)) return reject('STAFF_REQUIRED');
      const warnings = judge(input);
      const created: CalendarAppointment = { id: `n${next++}`, ...input, status: 'scheduled' };
      store.appointments.push(created);
      return { ok: true, value: { ...created, warnings } };
    },
    async appointment(id) {
      const a = store.appointments.find((x) => x.id === id);
      return a ? { ...a, version: a.version ?? 1 } : null;
    },
    async updateAppointment(id, change) {
      const a = store.appointments.find((x) => x.id === id);
      if (!a) return reject('NOT_FOUND');
      if ((a.version ?? 1) !== change.version) return reject('VERSION_CONFLICT');
      const { version, ...fields } = change;
      const after = { ...a, ...fields };
      const { moved, timing } = editScope(a, after);
      // 설계 12 D3: 담당자 필수는 시간·담당자 변경에만 — 기존 미지정 예약의 메모 수정은 된다.
      if (timing && staffMissing(after.staffId)) return reject('STAFF_REQUIRED');
      const warnings = timing && OCCUPYING.has(after.status) ? judge(after, a.id, !moved) : [];
      Object.assign(a, fields, { version: version + 1 });
      return { ok: true, value: { ...a, warnings } };
    },
    async setStatus(id, to) {
      const a = store.appointments.find((x) => x.id === id);
      if (!a) throw new Error('APPOINTMENT_NOT_FOUND');
      const change = changeStatus(a.status, to, { undoOfTask: false });
      if (!change.ok) return reject('INVALID_TRANSITION');
      // 상태 고치기는 시각을 바꾸지 않으므로 영업시간은 다시 보지 않고 겹침·차단만 본다(경고만, 저장은 한다).
      const warnings = change.needsOverlapCheck ? judge(a, a.id, true) : [];
      a.status = to;
      return { ok: true, value: { ...a, warnings } };
    },
    async createBlock(input) {
      if (!(Date.parse(input.startAt) < Date.parse(input.endAt))) throw new Error('INVALID_PERIOD');
      const created: CalendarBlock = { id: `nb${next++}`, ...input, staffIds: [...input.staffIds], version: 1 };
      store.blocks.push(created);
      return { ...created };
    },
    async removeBlock(id, version) {
      const i = store.blocks.findIndex((b) => b.id === id);
      if (i < 0) return reject('NOT_FOUND');
      if (version !== undefined && (store.blocks[i]!.version ?? 1) !== version) return reject('VERSION_CONFLICT');
      store.blocks.splice(i, 1);
      return { ok: true, value: null };
    },
  };
}

const CalendarApiContext = createContext<CalendarApi | null>(null);
export const CalendarApiProvider = CalendarApiContext.Provider;

let fakeApi: CalendarApi | null = null;
/** 주입한 것(테스트) → 명시적 가짜 모드면 메모리 → 아니면 로그인한 매장의 실제 API(설계 05 D2). */
export function useCalendarApi(): CalendarApi {
  const injected = useContext(CalendarApiContext);
  const shopId = useOptionalSession()?.shopId;
  return useMemo(() => {
    if (injected) return injected;
    if (FAKE_API) return (fakeApi ??= createMemoryCalendarApi());
    if (!shopId) throw new Error('useCalendarApi는 RequireSession 안에서만 쓴다');
    return createHttpCalendarApi(http, shopId);
  }, [injected, shopId]);
}

/** 테스트는 Provider로 캘린더를 주입한다. */
export function useHasCalendarApiProvider(): boolean {
  return useContext(CalendarApiContext) !== null;
}
