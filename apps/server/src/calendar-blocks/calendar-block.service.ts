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
   * 차단 고치기(#42 PATCH, 설계 09 D2). 받은 version을 확인한 뒤 보낸 칸을 지금 값에 합쳐 기간·대상을 다시 검사한다.
   * 전체로 바꾸면 연결을 비우고, 지정으로 바꾸면 새 집합을 저장한다. 새로 붙는 담당자는 사용 중이어야 하고,
   * 이미 연결된 숨긴 담당자는 집합에 남기면 그대로 둔다(D6). 대상만 바뀌어도 부모 version·수정 시각을 한 번 올린다.
   * 제거된 차단은 고칠 수 없다(404). 기존 예약은 그대로 — 겹침은 조회의 blockedBy로 보인다.
   */
  async update(client: PoolClient, shopId: string, id: string, input: unknown): Promise<CalendarBlock> {
    const patch = readPatch(input);
    if (!UUID.test(id)) throw blockNotFound();
    await lockShopWrites(client, shopId);
    const { rows: [row] } = await client.query<{ status: string; version: number; start_at: Date; end_at: Date; all_staff: boolean; memo: string | null }>(
      'SELECT status, version, start_at, end_at, all_staff, memo FROM crm.calendar_block WHERE shop_id = $1 AND id = $2 FOR UPDATE', [shopId, id]);
    if (!row) throw blockNotFound();
    if (row.version !== patch.version) throw versionConflict(row.version);
    if (row.status === 'removed') throw blockNotFound();
    const { rows: links } = await client.query<{ staff_id: string }>(
      'SELECT staff_id FROM crm.calendar_block_staff WHERE shop_id = $1 AND block_id = $2', [shopId, id]);
    const current = links.map((l) => l.staff_id);

    const start = patch.start ?? row.start_at;
    const end = patch.end ?? row.end_at;
    const allStaff = patch.allStaff ?? row.all_staff;
    const memo = patch.memo === undefined ? row.memo : patch.memo;
    const staffIds = allStaff ? [] : patch.staffIds ?? current;
    const errors: FieldError[] = [];
    if (!(start.getTime() < end.getTime())) errors.push({ field: 'endAt', code: 'INVALID_PERIOD' });
    if (allStaff && patch.staffIds && patch.staffIds.length > 0) errors.push({ field: 'staffIds', code: 'MUST_BE_EMPTY' });
    if (!allStaff && staffIds.length === 0) errors.push({ field: 'staffIds', code: 'REQUIRED' });
    if (errors.length > 0) throw invalid(errors);
    await checkStaff(client, shopId, staffIds.filter((s) => !current.includes(s)));

    const sameTargets = staffIds.length === current.length && staffIds.every((s) => current.includes(s));
    const unchanged = start.getTime() === row.start_at.getTime() && end.getTime() === row.end_at.getTime()
      && allStaff === row.all_staff && memo === row.memo && sameTargets;
    if (unchanged) return (await findActiveBlock(client, shopId, id))!;
    // 부모 행은 한 번만 고친다 — 트리거가 version·수정 시각을 올린다(대상만 바뀌어도).
    await client.query(
      'UPDATE crm.calendar_block SET start_at = $3, end_at = $4, all_staff = $5, memo = $6 WHERE shop_id = $1 AND id = $2',
      [shopId, id, start, end, allStaff, memo]);
    if (!sameTargets) {
      const drop = current.filter((s) => !staffIds.includes(s));
      if (drop.length > 0) {
        await client.query('DELETE FROM crm.calendar_block_staff WHERE shop_id = $1 AND block_id = $2 AND staff_id = ANY($3::uuid[])', [shopId, id, drop]);
      }
      for (const staffId of staffIds.filter((s) => !current.includes(s))) {
        await client.query('INSERT INTO crm.calendar_block_staff (shop_id, block_id, staff_id) VALUES ($1, $2, $3)', [shopId, id, staffId]);
      }
    }
    return (await findActiveBlock(client, shopId, id))!;
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

const PATCH_FIELDS = [...BODY_FIELDS, 'version'];

interface BlockPatch { version: number; start?: Date; end?: Date; allStaff?: boolean; staffIds?: string[]; memo?: string | null }

/** PATCH 본문: version만 필수, 나머지는 보낸 것만(모양 검사). 합친 값의 기간·대상 검사는 update에서. */
function readPatch(input: unknown): BlockPatch {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw invalid([{ field: '', code: 'INVALID_SHAPE' }]);
  const body = input as Record<string, unknown>;
  const errors: FieldError[] = [];
  for (const k of Object.keys(body)) if (!PATCH_FIELDS.includes(k)) errors.push({ field: k, code: 'UNKNOWN_FIELD' });
  const out: Partial<BlockPatch> = {};
  const v = body.version;
  if (typeof v === 'number' && Number.isInteger(v) && v >= 1) out.version = v;
  else errors.push({ field: 'version', code: v === undefined ? 'REQUIRED' : 'INVALID_VERSION' });
  for (const [k, key] of [['startAt', 'start'], ['endAt', 'end']] as const) {
    if (body[k] === undefined) continue;
    const at = parseInstant(body[k]);
    if (at) out[key] = at;
    else errors.push({ field: k, code: 'INVALID_DATETIME' });
  }
  if (body.allStaff !== undefined) {
    if (typeof body.allStaff === 'boolean') out.allStaff = body.allStaff;
    else errors.push({ field: 'allStaff', code: 'INVALID_TYPE' });
  }
  if (body.staffIds !== undefined) {
    const raw = body.staffIds;
    if (!Array.isArray(raw) || !raw.every((x) => typeof x === 'string' && UUID.test(x))) errors.push({ field: 'staffIds', code: 'INVALID_ID' });
    else {
      out.staffIds = raw.map((x: string) => x.toLowerCase());
      if (new Set(out.staffIds).size !== out.staffIds.length) errors.push({ field: 'staffIds', code: 'DUPLICATE' });
    }
  }
  if (body.memo !== undefined) {
    if (body.memo === null) out.memo = null;
    else if (typeof body.memo === 'string') out.memo = body.memo.trim() || null;
    else errors.push({ field: 'memo', code: 'INVALID_TYPE' });
  }
  if (errors.length > 0) throw invalid(errors);
  return out as BlockPatch;
}

function readVersion(v: unknown): number {
  const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN;
  if (!Number.isSafeInteger(n) || n < 1) throw invalid([{ field: 'version', code: v === undefined ? 'REQUIRED' : 'INVALID_VERSION' }]);
  return n;
}

function blockNotFound(): ApiError<'NOT_FOUND'> {
  return notFound('차단을 찾을 수 없습니다.');
}
