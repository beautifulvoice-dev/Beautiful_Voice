import type { CalendarBlock } from '@bv/contracts';
import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { invalid, notFound, parseInstant, UUID, versionConflict, type FieldError } from '../appointments-m1/appointment-m1.service';
import { ApiError } from '../common/api-error';
import { lockShopWrites } from '../common/shop-lock';
import { findActiveBlock } from './block-queries';

// 캘린더 차단 등록·제거(BEA-179, 설계 09 D1·D3·D6). 기존 예약과 겹쳐도 저장한다 — 겹침은 조회에서 blockedBy로 보인다(R50).
// 모든 함수는 idempotentWrite → withShop 트랜잭션의 client를 받고, 업무 조회 전에 매장 쓰기 잠금을 잡는다(Q3).
@Injectable()
export class CalendarBlockService {
  async create(client: PoolClient, shopId: string, input: unknown): Promise<CalendarBlock> {
    const block = readBlockInput(input);
    await lockShopWrites(client, shopId);
    await checkStaff(client, shopId, block.staffIds);
    const { rows: [row] } = await client.query<{ id: string }>(
      `INSERT INTO crm.calendar_block (shop_id, start_at, end_at, all_staff, memo) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [shopId, block.start, block.end, block.allStaff, block.memo]);
    for (const staffId of block.staffIds) {
      await client.query('INSERT INTO crm.calendar_block_staff (shop_id, block_id, staff_id) VALUES ($1, $2, $3)', [shopId, row!.id, staffId]);
    }
    return (await findActiveBlock(client, shopId, row!.id))!;
  }

  /**
   * active → removed(연결은 보존). D3: 없음·다른 매장은 404, 버전이 다르면 409, 현재 버전으로 이미 제거됐으면 404.
   * 같은 키·같은 버전의 성공 재전송은 idempotentWrite가 204를 재생한다.
   */
  async remove(client: PoolClient, shopId: string, id: string, rawVersion: unknown): Promise<void> {
    const version = readVersion(rawVersion);
    if (!UUID.test(id)) throw blockNotFound();
    await lockShopWrites(client, shopId);
    const { rows: [row] } = await client.query<{ status: string; version: number }>(
      'SELECT status, version FROM crm.calendar_block WHERE shop_id = $1 AND id = $2 FOR UPDATE', [shopId, id]);
    if (!row) throw blockNotFound();
    if (row.version !== version) throw versionConflict(row.version);
    if (row.status === 'removed') throw blockNotFound();
    await client.query(`UPDATE crm.calendar_block SET status = 'removed' WHERE shop_id = $1 AND id = $2`, [shopId, id]);
  }
}

const BODY_FIELDS = ['startAt', 'endAt', 'allStaff', 'staffIds', 'memo'];

interface BlockInput { start: Date; end: Date; allStaff: boolean; staffIds: string[]; memo: string | null }

function readBlockInput(input: unknown): BlockInput {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw invalid([{ field: '', code: 'INVALID_SHAPE' }]);
  const body = input as Record<string, unknown>;
  const errors: FieldError[] = [];
  for (const k of Object.keys(body)) if (!BODY_FIELDS.includes(k)) errors.push({ field: k, code: 'UNKNOWN_FIELD' });
  const instant = (k: 'startAt' | 'endAt') => {
    if (body[k] === undefined) return void errors.push({ field: k, code: 'REQUIRED' });
    const at = parseInstant(body[k]);
    if (!at) errors.push({ field: k, code: 'INVALID_DATETIME' });
    return at ?? undefined;
  };
  const start = instant('startAt');
  const end = instant('endAt');
  if (start && end && !(start.getTime() < end.getTime())) errors.push({ field: 'endAt', code: 'INVALID_PERIOD' });

  const allStaff = body.allStaff;
  if (allStaff === undefined) errors.push({ field: 'allStaff', code: 'REQUIRED' });
  else if (typeof allStaff !== 'boolean') errors.push({ field: 'allStaff', code: 'INVALID_TYPE' });
  // 전체면 빈 배열, 지정이면 중복 없는 UUID 1개 이상(#42·설계 09).
  const raw = body.staffIds;
  let staffIds: string[] = [];
  if (raw === undefined) errors.push({ field: 'staffIds', code: 'REQUIRED' });
  else if (!Array.isArray(raw) || !raw.every((v) => typeof v === 'string' && UUID.test(v))) errors.push({ field: 'staffIds', code: 'INVALID_ID' });
  else {
    staffIds = raw.map((v: string) => v.toLowerCase());
    if (new Set(staffIds).size !== staffIds.length) errors.push({ field: 'staffIds', code: 'DUPLICATE' });
    else if (allStaff === true && staffIds.length > 0) errors.push({ field: 'staffIds', code: 'MUST_BE_EMPTY' });
    else if (allStaff === false && staffIds.length === 0) errors.push({ field: 'staffIds', code: 'REQUIRED' });
  }
  let memo: string | null = null;
  if (body.memo !== undefined && body.memo !== null) {
    if (typeof body.memo !== 'string') errors.push({ field: 'memo', code: 'INVALID_TYPE' });
    else memo = body.memo.trim() || null;
  }
  if (errors.length > 0) throw invalid(errors);
  return { start: start!, end: end!, allStaff: allStaff as boolean, staffIds, memo };
}

/** 새 연결은 같은 매장의 사용 중인 담당자만(D6). 다른 매장 id는 "없음"과 같은 답. */
async function checkStaff(client: PoolClient, shopId: string, staffIds: string[]): Promise<void> {
  if (staffIds.length === 0) return;
  const { rows } = await client.query<{ id: string; active: boolean }>(
    'SELECT id, active FROM crm.staff WHERE shop_id = $1 AND id = ANY($2::uuid[])', [shopId, staffIds]);
  const found = new Map(rows.map((r) => [r.id, r.active]));
  const errors: FieldError[] = [];
  for (const id of staffIds) {
    if (!found.has(id)) errors.push({ field: 'staffIds', code: 'NOT_FOUND' });
    else if (!found.get(id)) errors.push({ field: 'staffIds', code: 'INACTIVE' });
  }
  if (errors.length > 0) throw invalid(errors.slice(0, 1));
}

function readVersion(v: unknown): number {
  const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN;
  if (!Number.isSafeInteger(n) || n < 1) throw invalid([{ field: 'version', code: v === undefined ? 'REQUIRED' : 'INVALID_VERSION' }]);
  return n;
}

function blockNotFound(): ApiError<'NOT_FOUND'> {
  return notFound('차단을 찾을 수 없습니다.');
}
