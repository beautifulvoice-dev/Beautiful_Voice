// 고객 창구의 실제 API 구현(#47·#48 서버, 계약 #42). 화면은 CustomerApi만 안다.
import type { FieldError } from '@bv/customers';
import type { Customer as ContractCustomer, SameNameCheckResponse } from '@bv/contracts';
import { HttpError, shopPath, type Http } from '@/lib/http';
import { randomKey } from '@/features/settings/useSaveAction';
import { CustomerConflictError, CustomerValidationError, type CustomerApi } from './api';
import type { Customer } from './model';

/** 목록을 끝까지 따라가는 상한. 1인 매장 M1 규모에서 100명 × 20쪽이면 충분하다. ASSUMPTION: 화면 쪽수 나누기는 후속. */
const PAGE = 100;
const MAX_PAGES = 20;

const toCustomer = (c: ContractCustomer): Customer => ({
  id: c.id,
  name: c.name,
  phone: c.phone ?? null,
  memo: c.memo ?? null,
  birthdate: c.birthdate ?? null,
  address: c.address ?? null,
  version: c.version,
  active: c.active,
});

function toCustomerError(err: unknown): unknown {
  if (!(err instanceof HttpError)) return err;
  if (err.code === 'VALIDATION_FAILED' && Array.isArray(err.details.fields)) return new CustomerValidationError(err.details.fields as FieldError[]);
  if (err.code === 'VERSION_CONFLICT') return new CustomerConflictError();
  return err;
}

export function createHttpCustomerApi(http: Http, shopId: string): CustomerApi {
  const path = (...s: string[]) => shopPath(shopId, 'customers', ...s);
  const mapped = <T,>(p: Promise<T>) => p.catch((e: unknown) => Promise.reject(toCustomerError(e)));

  return {
    async list(query, options) {
      const out: Customer[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < MAX_PAGES; i++) {
        const page: { items: ContractCustomer[]; nextCursor: string | null } = await http.get(path(), {
          query: { q: query.trim(), limit: PAGE, cursor, includeInactive: options?.includeInactive ? 'true' : undefined },
        });
        out.push(...page.items.map(toCustomer));
        cursor = page.nextCursor;
        if (!cursor) break;
      }
      return out;
    },
    async get(id) {
      try {
        // ASSUMPTION: M1에는 고객별 방문 이력 API가 없다(#42) — "이력 없음"으로 보이지 않게 null(준비 중)로 둔다.
        return { ...toCustomer(await http.get<ContractCustomer>(path(id))), visits: null };
      } catch (err) {
        if (err instanceof HttpError && err.status === 404) return null;
        throw err;
      }
    },
    async checkSameName(subject) {
      const r = await http.send<SameNameCheckResponse>('POST', path('same-name-check'), {
        body: { name: subject.name, phone: subject.phone, ...(subject.id ? { excludeId: subject.id } : {}) },
      });
      // active는 그대로 둔다 — W3가 숨긴 고객을 고를 수 없게 표시한다(04 D3).
      return { needsReview: r.needsReview, candidates: r.candidates.map(({ customerId, name, phone, hint, active }) => ({ customerId, name, phone, hint, active })) };
    },
    async create(input, options) {
      const created = await mapped(http.send<ContractCustomer>('POST', path(), { body: input, idempotencyKey: options?.idempotencyKey ?? randomKey() }));
      return toCustomer(created);
    },
    async update(id, patch, options) {
      if (options?.version === undefined) throw new Error('고객 고치기에는 읽은 version이 필요하다');
      const saved = await mapped(
        http.send<ContractCustomer>('PATCH', path(id), {
          body: { ...patch, version: options.version },
          idempotencyKey: options.idempotencyKey ?? randomKey(),
        }),
      );
      return toCustomer(saved);
    },
    async setActive(id, active, options) {
      if (options?.version === undefined) throw new Error('활성 바꾸기에는 읽은 version이 필요하다');
      try {
        const saved = await http.send<ContractCustomer>('PUT', path(id, 'active'), {
          body: { version: options.version, active },
          idempotencyKey: options.idempotencyKey ?? randomKey(),
        });
        return toCustomer(saved);
      } catch (err) {
        // 이미 그 상태(다른 기기에서 먼저 바꿈) — 실패로 보지 않고 최신 행을 돌려준다.
        if (err instanceof HttpError && err.code === 'NO_CHANGE') return toCustomer(await http.get<ContractCustomer>(path(id)));
        throw toCustomerError(err);
      }
    },
  };
}
