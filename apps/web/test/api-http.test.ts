// 설계 05 확인 기준: 매장 경로, 쿼리, 키 헤더, 수정 version, 정상 JSON·빈 204, 알려진·모르는 오류, 연결 실패. 합성 데이터만.
import { describe, expect, it } from 'vitest';
import { CustomerConflictError, CustomerValidationError } from '@/features/customers/api';
import { createHttpCustomerApi } from '@/features/customers/httpApi';
import { FieldsInvalidError, SettingsInvalidError, SettingsNotFoundError, VersionConflictError } from '@/features/settings/api';
import { createHttpSettingsApi } from '@/features/settings/httpApi';
import { createHttp, HttpError, NetworkError, shopPath, type Fetcher } from '@/lib/http';
import { createRetryKey } from '@/lib/retryKey';

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** 보낸 요청을 기록하고, 차례로 준비한 응답을 돌려주는 가짜 fetch. */
function fakeFetch(...replies: (Response | Error)[]): { fetcher: Fetcher; sent: Sent[] } {
  const sent: Sent[] = [];
  const fetcher: Fetcher = async (url, init) => {
    sent.push({
      url,
      method: init.method ?? 'GET',
      headers: init.headers as Record<string, string>,
      body: init.body ? JSON.parse(init.body as string) : undefined,
    });
    const next = replies.shift();
    if (!next) throw new Error('준비한 응답이 없다');
    if (!(next instanceof Response)) throw next;
    return next;
  };
  return { fetcher, sent };
}
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const fail = (status: number, code: string, details: unknown = {}) => json(status, { code, message: '서버 문구', details });

describe('공통 요청부', () => {
  it('매장 경로는 칸마다 인코딩하고, 빈 쿼리는 빼고, 쓰기에는 키·JSON 헤더를 붙인다', async () => {
    const { fetcher, sent } = fakeFetch(json(200, { ok: 1 }), new Response(null, { status: 204 }));
    const h = createHttp(fetcher);
    expect(shopPath('s 1', 'customers', 'a/b')).toBe('/api/shops/s%201/customers/a%2Fb');
    expect(await h.get('/x', { query: { q: '김 하늘', cursor: null, limit: 20, empty: '' } })).toEqual({ ok: 1 });
    expect(sent[0]!.url).toBe('/x?q=%EA%B9%80+%ED%95%98%EB%8A%98&limit=20');
    expect(sent[0]!.headers).toEqual({ Accept: 'application/json' });
    expect(await h.send('DELETE', '/y', { idempotencyKey: 'k1', body: { a: 1 } })).toBeUndefined();
    expect(sent[1]!.headers).toMatchObject({ 'Idempotency-Key': 'k1', 'Content-Type': 'application/json' });
  });

  it('오류 본문의 code·details를 읽고, 못 읽으면 UNKNOWN, 연결 실패는 NetworkError, 취소는 그대로', async () => {
    const { fetcher } = fakeFetch(
      fail(409, 'STAFF_OVERLAP', { conflictingIds: ['a1'] }),
      new Response('<html>', { status: 502 }),
      new TypeError('Failed to fetch'),
      new DOMException('aborted', 'AbortError'),
    );
    const h = createHttp(fetcher);
    const known = await h.get('/a').catch((e: unknown) => e);
    expect(known).toBeInstanceOf(HttpError);
    expect(known).toMatchObject({ status: 409, code: 'STAFF_OVERLAP', details: { conflictingIds: ['a1'] } });
    expect(await h.get('/b').catch((e: unknown) => e)).toMatchObject({ status: 502, code: 'UNKNOWN', details: {} });
    expect(await h.get('/c').catch((e: unknown) => e)).toBeInstanceOf(NetworkError);
    expect(await h.get('/d').catch((e: unknown) => (e as Error).name)).toBe('AbortError');
  });
});

describe('성공 응답 본문 유실', () => {
  it('201 헤더 뒤 본문 수신이 끊기면 NetworkError — 같은 키로 다시 보내게 한다', async () => {
    const broken = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('{"id":"c-'));
        c.error(new TypeError('network error'));
      },
    });
    const { fetcher } = fakeFetch(new Response(broken, { status: 201 }));
    const err = await createHttp(fetcher).send('POST', '/x', { body: {}, idempotencyKey: 'k' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetworkError);
  });
});

describe('저장 키', () => {
  it('같은 요청은 같은 키, 내용이 바뀌거나 결과가 확정되면 새 키', () => {
    let n = 0;
    const k = createRetryKey(() => `key-${++n}`);
    expect(k.keyFor('A')).toBe('key-1');
    expect(k.keyFor('A')).toBe('key-1');
    expect(k.keyFor('B')).toBe('key-2');
    k.settle();
    expect(k.keyFor('B')).toBe('key-3');
  });
});

describe('설정 실제 어댑터', () => {
  it('영업시간은 {businessHours}로 주고받고, 숨긴 것까지는 includeInactive=true', async () => {
    const hours = { '1': [{ open: '10:00', close: '20:00' }] };
    const { fetcher, sent } = fakeFetch(json(200, { businessHours: hours }), json(200, { businessHours: null }), json(200, { items: [] }));
    const api = createHttpSettingsApi(createHttp(fetcher), 'shop-1');
    expect(await api.getBusinessHours()).toEqual(hours);
    expect(await api.putBusinessHours(null, { idempotencyKey: 'k' })).toBeNull();
    expect(sent[1]).toMatchObject({ method: 'PUT', url: '/api/shops/shop-1/settings/business-hours', body: { businessHours: null } });
    expect(sent[1]!.headers['Idempotency-Key']).toBe('k');
    await api.listStaff({ includeInactive: true });
    expect(sent[2]!.url).toBe('/api/shops/shop-1/staff?includeInactive=true');
  });

  it('서버 거절을 화면이 아는 오류로 옮긴다', async () => {
    const { fetcher } = fakeFetch(
      fail(422, 'SETTINGS_INVALID', { reason: 'OPEN_NOT_BEFORE_CLOSE', at: '3[0]' }),
      fail(422, 'VALIDATION_FAILED', { fields: [{ field: 'name', code: 'REQUIRED' }] }),
      fail(409, 'VERSION_CONFLICT', { currentVersion: 4 }),
      fail(404, 'NOT_FOUND'),
    );
    const api = createHttpSettingsApi(createHttp(fetcher), 'shop-1');
    const e1 = await api.putBusinessHours({}).catch((e: unknown) => e);
    expect(e1).toBeInstanceOf(SettingsInvalidError);
    expect((e1 as SettingsInvalidError).error).toEqual({ code: 'OPEN_NOT_BEFORE_CLOSE', at: '3[0]' });
    expect(await api.addMenu({ name: '' }).catch((e: unknown) => e)).toBeInstanceOf(FieldsInvalidError);
    const e3 = await api.updateStaff('st-1', { version: 3, name: 'x' }).catch((e: unknown) => e);
    expect((e3 as VersionConflictError).currentVersion).toBe(4);
    expect(await api.removeClosure('c-1').catch((e: unknown) => e)).toBeInstanceOf(SettingsNotFoundError);
  });
});

const row = (over: Record<string, unknown> = {}) => ({
  id: 'c-1', name: '합성 고객', phone: '01000000001', memo: null, birthdate: null, address: null,
  version: 2, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', active: true, deactivatedAt: null, ...over,
});

describe('고객 실제 어댑터', () => {
  it('목록은 커서를 끝까지 따라간다', async () => {
    const { fetcher, sent } = fakeFetch(
      json(200, { items: [row()], nextCursor: 'n1' }),
      json(200, { items: [row({ id: 'c-2', name: '합성 둘' })], nextCursor: null }),
    );
    const api = createHttpCustomerApi(createHttp(fetcher), 'shop-1');
    expect((await api.list(' 합성 ')).map((c) => c.id)).toEqual(['c-1', 'c-2']);
    expect(sent.map((s) => s.url)).toEqual([
      '/api/shops/shop-1/customers?q=%ED%95%A9%EC%84%B1&limit=100',
      '/api/shops/shop-1/customers?q=%ED%95%A9%EC%84%B1&limit=100&cursor=n1',
    ]);
  });

  it('상세 404는 null, 고치기는 읽은 version과 키를 보내고 409·422를 옮긴다', async () => {
    const { fetcher, sent } = fakeFetch(
      fail(404, 'NOT_FOUND'),
      json(200, row({ version: 3, memo: '새 메모' })),
      fail(409, 'VERSION_CONFLICT', { currentVersion: 5 }),
      fail(422, 'VALIDATION_FAILED', { fields: [{ field: 'phone', code: 'PHONE_INVALID_FORMAT' }] }),
    );
    const api = createHttpCustomerApi(createHttp(fetcher), 'shop-1');
    expect(await api.get('none')).toBeNull();
    const saved = await api.update('c-1', { memo: '새 메모' }, { version: 2, idempotencyKey: 'k-1' });
    expect(saved).toMatchObject({ id: 'c-1', memo: '새 메모', version: 3, active: true });
    expect(sent[1]).toMatchObject({ method: 'PATCH', body: { memo: '새 메모', version: 2 } });
    expect(sent[1]!.headers['Idempotency-Key']).toBe('k-1');
    expect(await api.update('c-1', { memo: 'x' }, { version: 2 }).catch((e: unknown) => e)).toBeInstanceOf(CustomerConflictError);
    const invalid = await api.create({ name: '합성', phone: '12' }).catch((e: unknown) => e);
    expect(invalid).toBeInstanceOf(CustomerValidationError);
    expect((invalid as CustomerValidationError).errors).toEqual([{ field: 'phone', code: 'PHONE_INVALID_FORMAT' }]);
  });

  it('동명이인 확인은 키 없이 보내고, 수정 중이면 자기 자신을 뺀다', async () => {
    const candidate = { customerId: 'c-9', name: '합성 고객', phone: null, hint: 'phone_missing', active: false };
    const { fetcher, sent } = fakeFetch(json(200, { needsReview: true, candidates: [candidate] }));
    const api = createHttpCustomerApi(createHttp(fetcher), 'shop-1');
    const r = await api.checkSameName({ id: 'c-1', name: '합성 고객', phone: null });
    expect(r).toEqual({ needsReview: true, candidates: [candidate] });
    expect(sent[0]!.body).toEqual({ name: '합성 고객', phone: null, excludeId: 'c-1' });
    expect(sent[0]!.headers['Idempotency-Key']).toBeUndefined();
  });
});
