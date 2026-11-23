import type { CalendarBlock } from '@bv/contracts';
import type { ActiveBlock, Interval } from '@bv/scheduling/booking';
import type { PoolClient } from 'pg';

// 차단 읽기(설계 09). 모든 쿼리는 withShop 트랜잭션 안 + shop_id 조건(절대 규칙 5). 제거된 차단은 읽지 않는다.

interface BlockRow {
  id: string; start_at: Date; end_at: Date; all_staff: boolean; memo: string | null; version: number;
  created_at: Date; updated_at: Date; staff_ids: string[];
}

const BLOCK_SELECT = `
  SELECT b.id, b.start_at, b.end_at, b.all_staff, b.memo, b.version, b.created_at, b.updated_at,
         coalesce(array_agg(s.staff_id::text ORDER BY s.staff_id) FILTER (WHERE s.staff_id IS NOT NULL), '{}')::text[] AS staff_ids
    FROM crm.calendar_block b
    LEFT JOIN crm.calendar_block_staff s ON s.shop_id = b.shop_id AND s.block_id = b.id`;

export function toBlock(r: BlockRow): CalendarBlock {
  return {
    id: r.id, startAt: r.start_at.toISOString(), endAt: r.end_at.toISOString(), allStaff: r.all_staff,
    // 전체 차단은 빈 배열(#42).
    staffIds: r.all_staff ? [] : r.staff_ids, memo: r.memo, version: r.version,
    createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(),
  };
}

/** 차단 한 건(활성만). 없거나 제거됐으면 null. */
export async function findActiveBlock(client: PoolClient, shopId: string, id: string): Promise<CalendarBlock | null> {
  const { rows: [row] } = await client.query<BlockRow>(
    `${BLOCK_SELECT} WHERE b.shop_id = $1 AND b.id = $2 AND b.status = 'active' GROUP BY b.id`, [shopId, id]);
  return row ? toBlock(row) : null;
}

/** [from, to)와 겹치는 활성 차단. 원래 시작·끝 그대로, 시작·id 순(설계 09 §캘린더 조회). */
export async function blocksInRange(client: PoolClient, shopId: string, from: Date, to: Date): Promise<CalendarBlock[]> {
  const { rows } = await client.query<BlockRow>(
    `${BLOCK_SELECT}
      WHERE b.shop_id = $1 AND b.status = 'active' AND tstzrange(b.start_at, b.end_at, '[)') && tstzrange($2, $3, '[)')
      GROUP BY b.id ORDER BY b.start_at, b.id`, [shopId, from, to]);
  return rows.map(toBlock);
}

/** 이 담당자의 점유 구간에 걸리는 활성 차단(매장 전체 포함) — checkBooking에 넘긴다(설계 09 §예약 저장 2·3). */
export async function activeBlocksFor(client: PoolClient, shopId: string, staffId: string, occupied: Interval): Promise<ActiveBlock[]> {
  const { rows } = await client.query<BlockRow>(
    `${BLOCK_SELECT}
      WHERE b.shop_id = $1 AND b.status = 'active' AND tstzrange(b.start_at, b.end_at, '[)') && tstzrange($3, $4, '[)')
        AND (b.all_staff OR EXISTS (
          SELECT 1 FROM crm.calendar_block_staff t WHERE t.shop_id = b.shop_id AND t.block_id = b.id AND t.staff_id = $2))
      GROUP BY b.id ORDER BY b.start_at, b.id`, [shopId, staffId, occupied.start, occupied.end]);
  return rows.map((r) => ({ id: r.id, start: r.start_at, end: r.end_at, allStaff: r.all_staff, staffIds: r.staff_ids }));
}

/**
 * 예약 id → 그 예약의 **전체 점유 구간**과 겹치는 활성 차단 id(시작·id 순, 설계 09 D5).
 * 취소·무효는 점유가 아니라 빈 배열. 한 번의 집합 조회로 계산한다(예약마다 따로 묻지 않는다).
 */
export async function blockedByOf(client: PoolClient, shopId: string, appointmentIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (appointmentIds.length === 0) return out;
  const { rows } = await client.query<{ appointment_id: string; block_id: string }>(
    `SELECT a.id AS appointment_id, b.id AS block_id
       FROM crm.appointment_m1 a
       JOIN crm.calendar_block b
         ON b.shop_id = a.shop_id AND b.status = 'active' AND tstzrange(b.start_at, b.end_at, '[)') && a.occupied
      WHERE a.shop_id = $1 AND a.id = ANY($2::uuid[]) AND a.status IN ('scheduled', 'completed', 'no_show')
        AND (b.all_staff OR EXISTS (
          SELECT 1 FROM crm.calendar_block_staff t WHERE t.shop_id = a.shop_id AND t.block_id = b.id AND t.staff_id = a.staff_id))
      ORDER BY b.start_at, b.id`, [shopId, appointmentIds]);
  for (const r of rows) out.set(r.appointment_id, [...(out.get(r.appointment_id) ?? []), r.block_id]);
  return out;
}
