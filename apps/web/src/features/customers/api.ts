// 고객 화면이 데이터를 가져오는 창구. 화면은 이 인터페이스만 알고, 실제 API(C-07·F-07)가 생기면 구현만 바꾼다.
// 검증·동명이인 판정은 서버와 같은 C-02 로직(@bv/customers)을 쓴다 — 웹·음성 같은 규칙(절대 규칙 4).
import {
  applyPatch,
  nameKey,
  validateCustomerPatch,
  validateNewCustomer,
  type CustomerInput,
  type CustomerPatch,
  type FieldError,
} from '@bv/customers';
import { checkSameName, type SameNameCheck, type Subject } from '@bv/customers/duplicates';
import { createContext, useContext, useMemo } from 'react';
import { useOptionalSession } from '@/features/auth/session';
import { FAKE_API } from '@/lib/apiMode';
import { http } from '@/lib/http';
import { createHttpCustomerApi } from './httpApi';
import type { Customer, CustomerDetail, Visit } from './model';
import { seedCustomers, seedCustomersWithScene } from './mockData';

export class CustomerValidationError extends Error {
  readonly errors: FieldError[];
  constructor(errors: FieldError[]) {
    super('CUSTOMER_VALIDATION');
    this.errors = errors;
  }
}

/** 409 VERSION_CONFLICT — 그사이 다른 곳에서 고쳤다. 입력은 두고 최신 값을 다시 불러와 확인한다(설계 05 D4). */
export class CustomerConflictError extends Error {
  constructor() {
    super('VERSION_CONFLICT');
  }
}

/** 쓰기 요청 옵션. 실제 API는 Idempotency-Key 헤더와 읽은 version을 보낸다(절대 규칙 6, 계약 #42). */
export interface CustomerWriteOptions {
  idempotencyKey?: string;
  version?: number;
}

export interface CustomerApi {
  /** 이름(띄어쓰기 무시) 또는 전화번호 숫자 일부로 찾는다. 빈 검색어는 전체. */
  list(query: string): Promise<Customer[]>;
  get(id: string): Promise<CustomerDetail | null>;
  checkSameName(subject: Subject): Promise<SameNameCheck>;
  create(input: CustomerInput, options?: CustomerWriteOptions): Promise<Customer>;
  update(id: string, patch: CustomerPatch, options?: CustomerWriteOptions): Promise<Customer>;
}

export interface MemorySeed {
  customers: Customer[];
  visits: Record<string, Visit[]>;
}

/**
 * 서버 API 전 임시 저장소. 브라우저 메모리에만 있고 새로고침하면 처음 값으로 돌아간다.
 * ASSUMPTION: 한 매장의 데이터만 담는다. 매장 격리(shop_id)는 실제 API가 로그인 정보로 보장한다(F-03·F-04).
 */
export function createMemoryCustomerApi(seed: MemorySeed = seedCustomers()): CustomerApi {
  const customers = seed.customers.map((c) => ({ ...c }));
  let nextId = customers.length + 1;
  const find = (id: string) => customers.find((c) => c.id === id);

  return {
    async list(query) {
      const q = query.trim();
      const key = nameKey(q);
      const digits = q.replace(/\D/g, '');
      return customers
        .filter((c) => !q || nameKey(c.name).includes(key) || (digits.length >= 3 && (c.phone ?? '').includes(digits)))
        .sort((a, b) => a.name.localeCompare(b.name, 'ko'))
        .map((c) => ({ ...c }));
    },
    async get(id) {
      const c = find(id);
      if (!c) return null;
      return { ...c, visits: [...(seed.visits[id] ?? [])] };
    },
    async checkSameName(subject) {
      return checkSameName(subject, customers);
    },
    async create(input) {
      const r = validateNewCustomer(input);
      if (!r.ok) throw new CustomerValidationError(r.errors);
      const created = { id: `c${nextId++}`, ...r.value };
      customers.push(created);
      return { ...created };
    },
    async update(id, patch) {
      const c = find(id);
      if (!c) throw new Error('CUSTOMER_NOT_FOUND');
      const r = validateCustomerPatch(patch);
      if (!r.ok) throw new CustomerValidationError(r.errors);
      Object.assign(c, applyPatch(c, r.value));
      return { ...c };
    },
  };
}

const CustomerApiContext = createContext<CustomerApi | null>(null);
export const CustomerApiProvider = CustomerApiContext.Provider;

let fakeApi: CustomerApi | null = null;
/** 주입한 것(테스트) → 명시적 가짜 모드면 메모리 → 아니면 로그인한 매장의 실제 API(설계 05 D2). */
export function useCustomerApi(): CustomerApi {
  const injected = useContext(CustomerApiContext);
  const shopId = useOptionalSession()?.shopId;
  return useMemo(() => {
    if (injected) return injected;
    if (FAKE_API) return (fakeApi ??= createMemoryCustomerApi(seedCustomersWithScene()));
    if (!shopId) throw new Error('useCustomerApi는 RequireSession 안에서만 쓴다');
    return createHttpCustomerApi(http, shopId);
  }, [injected, shopId]);
}
