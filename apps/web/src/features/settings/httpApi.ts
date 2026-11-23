// 설정 창구의 실제 API 구현(#45·#46 서버, 계약 #42). 화면은 SettingsApi만 안다 — 서버 오류 code를 기존 오류 클래스로 옮긴다.
import type { BusinessHours, BusinessHoursBody, Closure, Menu, ShopInfo, Staff } from '@bv/contracts';
import type { ResourceErrorCode, ResourceField, SettingsError } from '@bv/scheduling/shop-settings';
import { HttpError, shopPath, type Http } from '@/lib/http';
import { randomKey } from './useSaveAction';
import { FieldsInvalidError, SettingsInvalidError, SettingsNotFoundError, VersionConflictError, type SettingsApi } from './api';

/** 서버 거절 → 화면이 아는 오류. 모르는 것은 그대로 던진다(연결 실패 등 → "다시 시도"). */
export function toSettingsError(err: unknown): unknown {
  if (!(err instanceof HttpError)) return err;
  const d = err.details;
  switch (err.code) {
    case 'SETTINGS_INVALID':
      return new SettingsInvalidError({ code: d.reason, ...(typeof d.at === 'string' ? { at: d.at } : {}) } as SettingsError);
    case 'VALIDATION_FAILED':
      return new FieldsInvalidError((Array.isArray(d.fields) ? d.fields : []) as { field: ResourceField; code: ResourceErrorCode }[]);
    case 'VERSION_CONFLICT':
      return new VersionConflictError(typeof d.currentVersion === 'number' ? d.currentVersion : 0);
    case 'NOT_FOUND':
      return new SettingsNotFoundError();
    default:
      return err;
  }
}

export function createHttpSettingsApi(http: Http, shopId: string): SettingsApi {
  const path = (...s: string[]) => shopPath(shopId, ...s);
  const mapped = <T,>(p: Promise<T>) => p.catch((e: unknown) => Promise.reject(toSettingsError(e)));
  const key = (o?: { idempotencyKey?: string }) => ({ idempotencyKey: o?.idempotencyKey ?? randomKey() });
  const includeInactive = (o?: { includeInactive?: boolean }) => (o?.includeInactive ? { includeInactive: true } : undefined);

  return {
    async getBusinessHours() {
      return (await mapped(http.get<BusinessHoursBody>(path('settings', 'business-hours')))).businessHours as BusinessHours | null;
    },
    async putBusinessHours(hours, o) {
      const r = await mapped(http.send<BusinessHoursBody>('PUT', path('settings', 'business-hours'), { body: { businessHours: hours }, ...key(o) }));
      return r.businessHours as BusinessHours | null;
    },
    getShopInfo: () => mapped(http.get<ShopInfo>(path('settings', 'shop-info'))),
    putShopInfo: (info, o) => mapped(http.send<ShopInfo>('PUT', path('settings', 'shop-info'), { body: info, ...key(o) })),
    async listClosures() {
      return (await mapped(http.get<{ items: Closure[] }>(path('closures')))).items;
    },
    addClosure: (input, o) => mapped(http.send<Closure>('POST', path('closures'), { body: input, ...key(o) })),
    removeClosure: (id, o) => mapped(http.send<void>('DELETE', path('closures', id), key(o))),
    async listMenus(o) {
      return (await mapped(http.get<{ items: Menu[] }>(path('menus'), { query: includeInactive(o) }))).items;
    },
    addMenu: (input, o) => mapped(http.send<Menu>('POST', path('menus'), { body: input, ...key(o) })),
    updateMenu: (id, patch, o) => mapped(http.send<Menu>('PATCH', path('menus', id), { body: patch, ...key(o) })),
    async listStaff(o) {
      return (await mapped(http.get<{ items: Staff[] }>(path('staff'), { query: includeInactive(o) }))).items;
    },
    addStaff: (input, o) => mapped(http.send<Staff>('POST', path('staff'), { body: input, ...key(o) })),
    updateStaff: (id, patch, o) => mapped(http.send<Staff>('PATCH', path('staff', id), { body: patch, ...key(o) })),
  };
}
