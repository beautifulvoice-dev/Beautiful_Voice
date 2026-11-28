import type { Page, PassSummary, WalletEntry, WalletSummary } from '@bv/contracts';
import type { PoolClient } from 'pg';
import { invalid, notFound, UUID, type FieldError } from '../appointments-m1/appointment-m1.service';
import { ApiError } from '../common/api-error';
import { decodeCursor, parseLimit, toPage } from '../common/pagination';

// 지갑 읽기(설계 13 §3 D5). 고객 상세는 요약을 먼저 읽고, 원장이 항목을 누르면 그 항목의 거래만 읽는다.
// 잔액은 삭제 표시가 없는 원장 행의 합계다(음수 그대로).

/** GET /api/wallets/{customerId} — 선불 잔액 + 보이는 횟수권(대표 먼저, 그다음 발급순). */
export async function walletSummary(client: PoolClient, shopId: string, customerId: string): Promise<WalletSummary> {
  await requireCustomerPath(client, shopId, customerId);
  const { rows: [prepaid] } = await client.query<{ total: string }>(
    `SELECT coalesce(sum(signed_delta), 0)::bigint AS total FROM crm.wallet_entry
      WHERE shop_id = $1 AND customer_id = $2 AND unit_type = 'amount' AND deleted_at IS NULL`, [shopId, customerId]);
  const { rows: passes } = await client.query<PassSummary & { remainingSessions: string }>(
    `SELECT p.id, p.name, p.menu_id AS "menuId", p.menu_name_snapshot AS "menuName", p.is_primary AS "isPrimary", p.version,
            coalesce(sum(e.signed_delta), 0)::bigint AS "remainingSessions"
       FROM crm.customer_pass p
       LEFT JOIN crm.wallet_entry e
         ON e.shop_id = p.shop_id AND e.customer_id = p.customer_id AND e.pass_id = p.id AND e.deleted_at IS NULL
      WHERE p.shop_id = $1 AND p.customer_id = $2 AND p.is_active
      GROUP BY p.id
      ORDER BY p.is_primary DESC, p.created_at, p.id`, [shopId, customerId]);
  return {
    customerId,
    prepaidBalance: Number(prepaid!.total),
    passes: passes.map((p) => ({ ...p, remainingSessions: Number(p.remainingSessions) })),
  };
}

const LIST_QUERY_FIELDS = new Set(['customerId', 'unitType', 'passId', 'cursor', 'limit']);
const CURSOR_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

function isWalletCursorTimestamp(value: string | number): boolean {
  if (typeof value !== 'string' || value.length !== 27 || !CURSOR_TIMESTAMP.test(value) || value.startsWith('0000-')) {
    return false;
  }
  // 달력·시각 검증만 밀리초로 한다. 쿼리에는 원래 마이크로초 문자열을 넘긴다.
  const milliseconds = `${value.slice(0, -4)}Z`;
  const date = new Date(milliseconds);
  return !Number.isNaN(date.getTime()) && date.toISOString() === milliseconds;
}

/** GET /api/wallet-entries — 한 항목(선불금 또는 횟수권 하나)의 거래, 최신순. 커서 = (발생 시각 µs, id). */
export async function walletEntries(
  client: PoolClient, shopId: string, query: Record<string, string | string[] | undefined>,
): Promise<Page<WalletEntry>> {
  const errors: FieldError[] = Object.keys(query).filter((k) => !LIST_QUERY_FIELDS.has(k)).map((field) => ({ field, code: 'UNKNOWN_FIELD' }));
  const { customerId, unitType, passId } = query;
  if (customerId === undefined) errors.push({ field: 'customerId', code: 'REQUIRED' });
  else if (typeof customerId !== 'string' || !UUID.test(customerId)) errors.push({ field: 'customerId', code: 'INVALID_ID' });
  if (unitType === undefined) errors.push({ field: 'unitType', code: 'REQUIRED' });
  else if (unitType !== 'amount' && unitType !== 'sessions') errors.push({ field: 'unitType', code: 'INVALID_VALUE' });
  if (unitType === 'sessions' && passId === undefined) errors.push({ field: 'passId', code: 'REQUIRED' });
  else if (unitType === 'sessions' && (typeof passId !== 'string' || !UUID.test(passId))) errors.push({ field: 'passId', code: 'INVALID_ID' });
  else if (unitType === 'amount' && passId !== undefined) errors.push({ field: 'passId', code: 'MUST_BE_EMPTY' });
  if (errors.length > 0) throw invalid(errors);
  const limit = parseLimit(query.limit);
  const cursor = decodeCursor(query.cursor);
  if (cursor && (!isWalletCursorTimestamp(cursor.v) || !UUID.test(cursor.id))) {
    throw new ApiError(400, 'INVALID_CURSOR', 'cursor is invalid');
  }

  await requireCustomerPath(client, shopId, customerId as string);
  const pass = unitType === 'sessions' ? passId as string : null;
  if (pass !== null) {
    const { rowCount } = await client.query('SELECT 1 FROM crm.customer_pass WHERE shop_id = $1 AND customer_id = $2 AND id = $3',
      [shopId, customerId, pass]);
    if (!rowCount) throw notFound('횟수권을 찾을 수 없습니다.');
  }
  const { rows } = await client.query<EntryRow>(
    `SELECT id, customer_id, unit_type, pass_id, label, signed_delta, appointment_id, cycle_seq, memo, version, created_at, updated_at,
            to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
       FROM crm.wallet_entry
      WHERE shop_id = $1 AND customer_id = $2 AND unit_type = $3 AND pass_id IS NOT DISTINCT FROM $4::uuid AND deleted_at IS NULL
        AND ($5::timestamptz IS NULL OR (created_at, id) < ($5::timestamptz, $6::uuid))
      ORDER BY created_at DESC, id DESC
      LIMIT $7`,
    [shopId, customerId, unitType, pass, cursor?.v ?? null, cursor?.id ?? null, limit + 1]);
  const page = toPage(rows, limit, (row) => ({ v: row.cursor_at, id: row.id }));
  return { items: page.items.map(toWalletEntry), nextCursor: page.nextCursor };
}

/** 경로·쿼리의 고객: 이 매장에 없으면 404(본문의 고객은 422 — 공통 지갑 함수가 정한다). */
async function requireCustomerPath(client: PoolClient, shopId: string, customerId: string): Promise<void> {
  if (!UUID.test(customerId)) throw notFound('고객을 찾을 수 없습니다.');
  const { rowCount } = await client.query('SELECT 1 FROM crm.customer WHERE shop_id = $1 AND id = $2', [shopId, customerId]);
  if (!rowCount) throw notFound('고객을 찾을 수 없습니다.');
}

interface EntryRow {
  id: string; customer_id: string; unit_type: WalletEntry['unitType']; pass_id: string | null; label: WalletEntry['label'];
  signed_delta: number; appointment_id: string | null; cycle_seq: number | null; memo: string | null; version: number;
  created_at: Date; updated_at: Date; cursor_at: string;
}

function toWalletEntry(row: EntryRow): WalletEntry {
  return {
    id: row.id, customerId: row.customer_id, unitType: row.unit_type, passId: row.pass_id, label: row.label,
    signedDelta: row.signed_delta, appointmentId: row.appointment_id, cycleSeq: row.cycle_seq, memo: row.memo,
    version: row.version, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
  };
}
