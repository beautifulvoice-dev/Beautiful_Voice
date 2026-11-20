import type { Customer, Page, SameNameCheckResponse } from '@bv/contracts';
import {
  applyPatch, type CustomerPatch as PatchValues, type CustomerValues, nameKey, validateCustomerPatch, validateNewCustomer,
} from '@bv/customers';
import { checkSameName } from '@bv/customers/duplicates';
import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApiError } from '../common/api-error';
import { decodeCursor, parseLimit, toPage } from '../common/pagination';

// 고객 등록·검색·수정·동명이인(BEA-172). 검사·정규화는 @bv/customers(#38) — 웹·음성과 같은 규칙(절대 규칙 4).
// 모든 쿼리는 withShop 트랜잭션 안 + shop_id 조건(절대 규칙 5). version·updated_at은 DB 트리거가 올린다(#43 010).
// 고객 이름·전화는 개인정보다 — 오류 메시지·details·로그에 넣지 않는다(절대 규칙 8).
@Injectable()
export class CustomerService {
  /**
   * 이름(띄어쓰기·대소문자 무시) 또는 전화번호 숫자 3자리 이상, 부분 일치. 이름순 + keyset 커서(설계 D1·D2).
   * 인덱스 없이 매장 고객을 훑는다 — 1인 매장 규모(수백~수천 명)에서 충분. 커지면 name_key + pg_trgm(스키마 변경).
   */
  async list(
    client: PoolClient, shopId: string,
    query: { q?: string; includeInactive?: string; cursor?: string; limit?: string },
  ): Promise<Page<Customer>> {
    const limit = parseLimit(query.limit);
    const cursor = decodeCursor(query.cursor);
    if (cursor && (typeof cursor.v !== 'string' || !UUID.test(cursor.id))) throw new ApiError(400, 'INVALID_CURSOR', 'cursor is invalid');
    const q = typeof query.q === 'string' ? query.q.trim() : '';
    const key = q === '' ? null : `%${escapeLike(nameKey(q))}%`;
    const digits = q.replace(/\D/g, '');
    const phone = digits.length >= 3 ? `%${digits}%` : null;
    const { rows } = await client.query<Customer>(
      `SELECT ${COLUMNS} FROM crm.customer
        WHERE shop_id = $1
          AND (active OR $2)
          AND ($3::text IS NULL OR ${NAME_KEY_SQL} LIKE $3 ESCAPE '\\' OR ($4::text IS NOT NULL AND phone LIKE $4))
          AND ($5::text IS NULL OR (name COLLATE "C", id) > ($5::text COLLATE "C", $6::uuid))
        ORDER BY name COLLATE "C", id
        LIMIT $7`,
      [shopId, query.includeInactive === 'true', key, phone, cursor?.v ?? null, cursor?.id ?? null, limit + 1]);
    return toPage(rows, limit, (c) => ({ v: c.name, id: c.id }));
  }

  async get(client: PoolClient, shopId: string, customerId: string): Promise<Customer> {
    if (!UUID.test(customerId)) throw notFound();
    // 비활성 고객도 읽힌다 — 예약·지갑 기록은 남는다(결정 R30).
    const { rows: [row] } = await client.query<Customer>(`SELECT ${COLUMNS} FROM crm.customer WHERE shop_id = $1 AND id = $2`, [shopId, customerId]);
    if (!row) throw notFound();
    return row;
  }

  /** 이름만 있어도 등록된다. 이름·전화가 같은 고객도 막지 않는다(AC-CRM-8) — 화면이 먼저 sameNameCheck로 묻는다. */
  async create(client: PoolClient, shopId: string, input: unknown): Promise<Customer> {
    const body = objectOf(input);
    const typeErrors: FieldError[] = [];
    const checked = validateNewCustomer({
      name: textOf(body, 'name', typeErrors) ?? '',
      phone: textOf(body, 'phone', typeErrors), memo: textOf(body, 'memo', typeErrors),
      birthdate: textOf(body, 'birthdate', typeErrors), address: textOf(body, 'address', typeErrors),
    });
    if (typeErrors.length > 0 || !checked.ok) throw invalid([...typeErrors, ...(checked.ok ? [] : checked.errors)]);
    const v = checked.value;
    // created_source는 서버가 정한다: 원장 웹 등록 = manual(계약 #42).
    const { rows: [row] } = await client.query<Customer>(
      `INSERT INTO crm.customer (shop_id, name, phone, notes, birthdate, address, created_source)
       VALUES ($1, $2, $3, $4, $5, $6, 'manual') RETURNING ${COLUMNS}`,
      [shopId, v.name, v.phone, v.memo, v.birthdate ?? null, v.address ?? null]);
    return row!;
  }

  /**
   * 같은 이름(nameKey) 고객 후보. 저장하지 않고 병합도 하지 않는다(PD-50).
   * 비활성 고객도 넣고 active로 알린다 → 새로 등록하기 전에 되살리기를 권할 수 있다(설계 D3, S4).
   */
  async sameNameCheck(client: PoolClient, shopId: string, input: unknown): Promise<SameNameCheckResponse> {
    const body = objectOf(input);
    const typeErrors: FieldError[] = [];
    const checked = validateNewCustomer({ name: textOf(body, 'name', typeErrors) ?? '', phone: textOf(body, 'phone', typeErrors) });
    if (typeErrors.length > 0 || !checked.ok) throw invalid([...typeErrors, ...(checked.ok ? [] : checked.errors)]);
    const excludeId = typeof body.excludeId === 'string' && UUID.test(body.excludeId) ? body.excludeId : undefined;
    const { rows } = await client.query<{ id: string; name: string; phone: string | null; active: boolean }>(
      `SELECT id, name, phone, active FROM crm.customer WHERE shop_id = $1 AND ${NAME_KEY_SQL} = $2 ORDER BY created_at, id`,
      [shopId, nameKey(checked.value.name)]);
    const active = new Map(rows.map((r) => [r.id, r.active]));
    const result = checkSameName({ id: excludeId, name: checked.value.name, phone: checked.value.phone }, rows);
    return { needsReview: result.needsReview, candidates: result.candidates.map((c) => ({ ...c, active: active.get(c.customerId)! })) };
  }

  /**
   * 보낸 칸만 바꾼다(null = 비우기, 이름은 비울 수 없음). 행을 잠그고 받은 version을 확인해
   * 두 화면에서 같은 고객을 고치면 뒤의 저장을 409로 거부한다(BEA-172 수용 기준).
   * 바뀐 값이 없으면 저장하지 않고 지금 값을 돌려준다 — version이 오르지 않는다(설계 D5).
   */
  async update(client: PoolClient, shopId: string, customerId: string, input: unknown): Promise<Customer> {
    const body = objectOf(input);
    const current = await this.lock(client, shopId, customerId, body.version);
    const typeErrors: FieldError[] = [];
    const patch: PatchValues = {};
    for (const field of FIELDS) {
      if (body[field] === undefined) continue;
      const value = textOf(body, field, typeErrors);
      if (field === 'name') patch.name = value ?? '';
      else patch[field] = value;
    }
    const checked = validateCustomerPatch(patch);
    if (typeErrors.length > 0 || !checked.ok) throw invalid([...typeErrors, ...(checked.ok ? [] : checked.errors)]);
    const before: CustomerValues = {
      name: current.name, phone: current.phone, memo: current.memo, birthdate: current.birthdate, address: current.address,
    };
    const after = applyPatch(before, checked.value);
    if (FIELDS.every((f) => (after[f] ?? null) === (before[f] ?? null))) return current;
    const { rows: [row] } = await client.query<Customer>(
      `UPDATE crm.customer SET name = $3, phone = $4, notes = $5, birthdate = $6, address = $7
        WHERE shop_id = $1 AND id = $2 RETURNING ${COLUMNS}`,
      [shopId, customerId, after.name, after.phone, after.memo, after.birthdate ?? null, after.address ?? null]);
    return row!;
  }

  /** 고칠 행을 잠그고(FOR UPDATE) 가져온다. 없으면 404, 받은 version이 지금 값과 다르면 409 {currentVersion}. */
  protected async lock(client: PoolClient, shopId: string, customerId: string, version: unknown): Promise<Customer> {
    if (!Number.isInteger(version) || (version as number) < 1) throw invalid([{ field: 'version', code: 'REQUIRED' }]);
    if (!UUID.test(customerId)) throw notFound();
    const { rows: [row] } = await client.query<Customer>(
      `SELECT ${COLUMNS} FROM crm.customer WHERE shop_id = $1 AND id = $2 FOR UPDATE`, [shopId, customerId]);
    if (!row) throw notFound();
    if (row.version !== version) {
      throw new ApiError(409, 'VERSION_CONFLICT', '다른 곳에서 먼저 고쳤어요. 새로 불러와 주세요.', { currentVersion: row.version });
    }
    return row;
  }
}

// 계약 memo ↔ DB notes. date는 ::text로(서버 시간대 때문에 하루 밀리지 않게).
export const COLUMNS = `id, version, created_at AS "createdAt", updated_at AS "updatedAt", name, phone, notes AS memo,
  birthdate::text AS birthdate, address, active, deactivated_at AS "deactivatedAt"`;
// @bv/customers nameKey와 같은 규칙: 공백을 모두 지우고 소문자.
const NAME_KEY_SQL = `regexp_replace(lower(name), '\\s', '', 'g')`;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FIELDS = ['name', 'phone', 'memo', 'birthdate', 'address'] as const;

type FieldError = { field: string; code: string };

function objectOf(input: unknown): Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
}

/** 글·null·빠짐만 받는다. 숫자 같은 값은 조용히 바꾸지 않고 INVALID_TYPE. */
function textOf(body: Record<string, unknown>, field: string, errors: FieldError[]): string | null {
  const value = body[field];
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value;
  errors.push({ field, code: 'INVALID_TYPE' });
  return null;
}

// 검색어의 %·_·\는 글자로 찾는다.
function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => '\\' + c);
}

export function invalid(errors: readonly FieldError[]): ApiError<'VALIDATION_FAILED'> {
  return new ApiError(422, 'VALIDATION_FAILED', '입력값을 확인해 주세요.', { fields: errors });
}

export function notFound(): ApiError<'NOT_FOUND'> {
  return new ApiError(404, 'NOT_FOUND', '고객을 찾을 수 없습니다.');
}
