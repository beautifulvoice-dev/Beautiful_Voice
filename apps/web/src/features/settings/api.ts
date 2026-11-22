// 설정 화면(BEA-166 영업시간·휴무, BEA-167 메뉴·담당자)이 데이터를 주고받는 창구.
// 화면은 이 인터페이스만 안다. 모양은 M1 계약(@bv/contracts crm)과 같고, 서버가 생기면 구현만 바꾼다(고객 화면과 같은 방식).
// 입력 검사는 서버와 같은 함수(@bv/scheduling/shop-settings)를 쓴다 — 규칙을 두 벌 두지 않는다(절대 규칙 4).
// 설정은 사람만 바꾼다. AI 실행기에는 설정 쓰기 권한이 없다(결정 R0).
import type { BusinessHours, Closure, ClosureInput, Menu, MenuInput, MenuPatch, Staff, StaffPatch } from '@bv/contracts';
import {
  validateBusinessHours,
  validateClosure,
  validateMenu,
  validateStaff,
  type ResourceErrorCode,
  type ResourceField,
  type SettingsError,
} from '@bv/scheduling/shop-settings';
import { createContext, useContext, useMemo } from 'react';
import { useOptionalSession } from '@/features/auth/session';
import { FAKE_API } from '@/lib/apiMode';
import { http } from '@/lib/http';
import { createHttpSettingsApi } from './httpApi';
import { seedSettings } from './mockData';

/** 422 SETTINGS_INVALID — 영업시간·휴무 모양이 틀림. at은 문제 위치(예 "2[0]" = 화요일 첫 구간). */
export class SettingsInvalidError extends Error {
  readonly error: SettingsError;
  constructor(error: SettingsError) {
    super('SETTINGS_INVALID');
    this.error = error;
  }
}

/** 422 VALIDATION_FAILED — 메뉴·담당자 칸 오류. */
export class FieldsInvalidError extends Error {
  readonly errors: { field: ResourceField; code: ResourceErrorCode }[];
  constructor(errors: { field: ResourceField; code: ResourceErrorCode }[]) {
    super('VALIDATION_FAILED');
    this.errors = errors;
  }
}

/** 409 VERSION_CONFLICT — 다른 곳에서 먼저 고쳤다. 다시 불러와서 고쳐야 한다. */
export class VersionConflictError extends Error {
  readonly currentVersion: number;
  constructor(currentVersion: number) {
    super('VERSION_CONFLICT');
    this.currentVersion = currentVersion;
  }
}

/** 404 — 없거나 이미 지운 항목. */
export class SettingsNotFoundError extends Error {
  constructor() {
    super('NOT_FOUND');
  }
}

export interface ListOptions {
  /** true면 숨긴(active=false) 것도 함께. 기본은 사용 중인 것만(계약 IncludeInactive). */
  includeInactive?: boolean;
}

/** 쓰기 요청마다 붙이는 값. 실제 API는 Idempotency-Key 헤더로 보낸다(절대 규칙 6). */
export interface WriteOptions {
  idempotencyKey?: string;
}

export interface SettingsApi {
  /** null = 아직 넣지 않음 → 예약 저장 때 영업시간 검사를 하지 않는다. */
  getBusinessHours(): Promise<BusinessHours | null>;
  /** 통째로 바꾼다. 이미 있는 예약은 그대로 둔다(파생 S2). */
  putBusinessHours(hours: BusinessHours | null, options?: WriteOptions): Promise<BusinessHours | null>;
  listClosures(): Promise<Closure[]>;
  addClosure(input: ClosureInput, options?: WriteOptions): Promise<Closure>;
  /** 휴무는 고치지 않고 추가·삭제만 한다(그래서 version이 없다). */
  removeClosure(id: string, options?: WriteOptions): Promise<void>;
  listMenus(options?: ListOptions): Promise<Menu[]>;
  addMenu(input: MenuInput, options?: WriteOptions): Promise<Menu>;
  /** 고치기와 숨기기(active=false). 메뉴는 지우지 않는다 — 지난 예약이 가리킨다. */
  updateMenu(id: string, patch: MenuPatch, options?: WriteOptions): Promise<Menu>;
  listStaff(options?: ListOptions): Promise<Staff[]>;
  addStaff(input: { name: string }, options?: WriteOptions): Promise<Staff>;
  updateStaff(id: string, patch: StaffPatch, options?: WriteOptions): Promise<Staff>;
}

export interface SettingsSeed {
  businessHours: BusinessHours | null;
  closures: Closure[];
  menus: Menu[];
  staff: Staff[];
}

/** 계약은 요일 키가 '1'~'7' 문자열, 검사 함수는 숫자 키다. 값은 같으므로 키 모양만 맞춘다. */
function toContractHours(hours: Partial<Record<number, { open: string; close: string }[]>>): BusinessHours {
  const out: BusinessHours = {};
  for (const [day, windows] of Object.entries(hours)) {
    if (windows) out[day as keyof BusinessHours] = windows.map((w) => ({ ...w }));
  }
  return out;
}

const clone = <T,>(v: T): T => structuredClone(v);

/**
 * 서버 API 전 임시 저장소. 브라우저 메모리에만 있고 새로고침하면 처음 값으로 돌아간다.
 * ASSUMPTION: 한 매장의 데이터만 담는다. 매장 격리(shop_id)는 실제 API가 경로의 shopId와 로그인 정보로 보장한다.
 */
export function createMemorySettingsApi(seed: SettingsSeed = seedSettings(), now: () => Date = () => new Date()): SettingsApi {
  let businessHours = clone(seed.businessHours);
  const closures = clone(seed.closures);
  const menus = clone(seed.menus);
  const staff = clone(seed.staff);
  let nextId = 1;
  const newId = (prefix: string) => `${prefix}-new-${nextId++}`;
  const stamp = () => now().toISOString();

  function findVersioned<T extends { id: string; version: number }>(rows: T[], id: string, version: number): T {
    const row = rows.find((r) => r.id === id);
    if (!row) throw new SettingsNotFoundError();
    if (row.version !== version) throw new VersionConflictError(row.version);
    return row;
  }

  // 같은 Idempotency-Key로 다시 오면 처음 결과를 그대로 돌려준다(서버와 같은 약속).
  const done = new Map<string, unknown>();
  async function once<T>(options: WriteOptions | undefined, write: () => Promise<T>): Promise<T> {
    const key = options?.idempotencyKey;
    if (key && done.has(key)) return clone(done.get(key) as T);
    const result = await write();
    if (key) done.set(key, clone(result));
    return result;
  }

  const visible = <T extends { active: boolean }>(rows: T[], options?: ListOptions) =>
    rows.filter((r) => options?.includeInactive || r.active).map(clone);

  return {
    async getBusinessHours() {
      return clone(businessHours);
    },
    putBusinessHours(hours, options) {
      return once(options, async () => {
        const r = validateBusinessHours(hours);
        if (!r.ok) throw new SettingsInvalidError(r.error);
        businessHours = r.value === null ? null : toContractHours(r.value);
        return clone(businessHours);
      });
    },

    async listClosures() {
      return closures.map(clone);
    },
    addClosure(input, options) {
      return once(options, async () => {
        const r = validateClosure(input);
        if (!r.ok) throw new SettingsInvalidError(r.error);
        // 검사 함수는 메모를 보지 않으므로 입력의 메모를 그대로 붙인다.
        const created = { ...r.value, note: input.note ?? null, id: newId('closure') } as Closure;
        closures.push(created);
        return clone(created);
      });
    },
    removeClosure(id, options) {
      return once(options, async () => {
        const i = closures.findIndex((c) => c.id === id);
        if (i < 0) throw new SettingsNotFoundError();
        closures.splice(i, 1);
      });
    },

    async listMenus(options) {
      return visible(menus, options);
    },
    addMenu(input, options) {
      return once(options, async () => {
        const r = validateMenu(input);
        if (!r.ok) throw new FieldsInvalidError(r.errors);
        const at = stamp();
        const created: Menu = { ...r.value, id: newId('menu'), version: 1, active: true, createdAt: at, updatedAt: at };
        menus.push(created);
        return clone(created);
      });
    },
    updateMenu(id, patch, options) {
      return once(options, async () => {
        const row = findVersioned(menus, id, patch.version);
        const r = validateMenu({
          name: patch.name ?? row.name,
          defaultDurationMin: patch.defaultDurationMin === undefined ? row.defaultDurationMin : patch.defaultDurationMin,
          defaultPrepMin: patch.defaultPrepMin === undefined ? row.defaultPrepMin : patch.defaultPrepMin,
      });
      if (!r.ok) throw new FieldsInvalidError(r.errors);
      Object.assign(row, r.value, { active: patch.active ?? row.active, version: row.version + 1, updatedAt: stamp() });
      return clone(row);
      });
    },

    async listStaff(options) {
      return visible(staff, options);
    },
    addStaff(input, options) {
      return once(options, async () => {
        const r = validateStaff(input);
        if (!r.ok) throw new FieldsInvalidError(r.errors);
        const at = stamp();
        const created: Staff = { ...r.value, id: newId('staff'), version: 1, active: true, createdAt: at, updatedAt: at };
        staff.push(created);
        return clone(created);
      });
    },
    updateStaff(id, patch, options) {
      return once(options, async () => {
        const row = findVersioned(staff, id, patch.version);
        const r = validateStaff({ name: patch.name ?? row.name });
        if (!r.ok) throw new FieldsInvalidError(r.errors);
        Object.assign(row, r.value, { active: patch.active ?? row.active, version: row.version + 1, updatedAt: stamp() });
        return clone(row);
      });
    },
  };
}

const SettingsApiContext = createContext<SettingsApi | null>(null);
export const SettingsApiProvider = SettingsApiContext.Provider;

let fakeApi: SettingsApi | null = null;
/** 주입한 것(테스트) → 명시적 가짜 모드면 메모리 → 아니면 로그인한 매장의 실제 API(설계 05 D2). */
export function useSettingsApi(): SettingsApi {
  const injected = useContext(SettingsApiContext);
  const shopId = useOptionalSession()?.shopId;
  return useMemo(() => {
    if (injected) return injected;
    if (FAKE_API) return (fakeApi ??= createMemorySettingsApi());
    if (!shopId) throw new Error('useSettingsApi는 RequireSession 안에서만 쓴다');
    return createHttpSettingsApi(http, shopId);
  }, [injected, shopId]);
}
