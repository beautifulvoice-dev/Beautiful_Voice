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
    async list(query) {
      const out: Customer[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < MAX_PAGES; i++) {
        const page: { items: ContractCustomer[]; nextCursor: string | null } = await http.get(path(), {
          query: { q: query.trim(), limit: PAGE, cursor },
        });
        out.push(...page.items.map(toCustomer));
        cursor = page.nextCursor;
        if (!cursor) break;
      }
      return out;
    },
    async get(id) {
      try {
        // ASSUMPTION: M1에는 고객별 방문 이력 API가 없다(#42) — 이력은 빈 목록으로 둔다.
        return { ...toCustomer(await http.get<ContractCustomer>(path(id))), visits: [] };
      } catch (err) {
        if (err instanceof HttpError && err.status === 404) return null;
        throw err;
      }
    },
    async checkSameName(subject) {
      const r = await http.send<SameNameCheckResponse>('POST', path('same-name-check'), {
        body: { name: subject.name, phone: subject.phone, ...(subject.id ? { excludeId: subject.id } : {}) },
      });
      return { needsReview: r.needsReview, candidates: r.candidates.map(({ customerId, name, phone, hint }) => ({ customerId, name, phone, hint })) };
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
  };
}
