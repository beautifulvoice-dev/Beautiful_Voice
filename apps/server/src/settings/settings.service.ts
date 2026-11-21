import type { BusinessHours, BusinessHoursBody, Closure, ShopInfo } from '@bv/contracts';
import { validateBusinessHours, validateClosure, validateShopInfo } from '@bv/scheduling/shop-settings';
import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApiError } from '../common/api-error';
import { shopNotFound } from '../common/owner-shop.guard';

// 매장 설정 쓰기·읽기(BEA-166). 모든 함수는 DatabaseService.withShop 트랜잭션의 client를 받는다 →
// RLS가 그 매장 행만 보여 주지만, 쿼리에도 shop_id 조건을 같이 쓴다(절대 규칙 5, 2중 안전장치).
// 입력 검사는 @bv/scheduling/shop-settings(#39) — 웹 폼과 같은 함수다.
// 설정은 사람만 바꾼다(결정 R0): 이 서비스는 원장 세션 컨트롤러에서만 부른다.
@Injectable()
export class SettingsService {
  // ── 영업시간 ──
  async businessHours(client: PoolClient, shopId: string): Promise<BusinessHoursBody> {
    const { rows: [row] } = await client.query<{ business_hours: BusinessHours | null }>(
      'SELECT business_hours FROM crm.shop_settings WHERE shop_id = $1', [shopId]);
    if (!row) throw shopNotFound();
    return { businessHours: row.business_hours };
  }

  async saveBusinessHours(client: PoolClient, shopId: string, input: unknown): Promise<BusinessHoursBody> {
    const checked = validateBusinessHours(input);
    if (!checked.ok) throw settingsInvalid(checked.error.code, checked.error.at);
    // 이미 있는 예약은 건드리지 않는다(파생 S2) — 새 영업시간은 다음 예약 저장부터 적용된다.
    const { rows: [row] } = await client.query<{ business_hours: BusinessHours | null }>(
      'UPDATE crm.shop_settings SET business_hours = $2, updated_at = now() WHERE shop_id = $1 RETURNING business_hours',
      [shopId, checked.value === null ? null : JSON.stringify(checked.value)]);
    if (!row) throw shopNotFound();
    return { businessHours: row.business_hours };
  }

  // ── 매장 안내 정보 ──
  async shopInfo(client: PoolClient, shopId: string): Promise<ShopInfo> {
    const { rows: [row] } = await client.query<ShopInfo>(`SELECT ${SHOP_INFO_COLUMNS} FROM crm.shop_settings WHERE shop_id = $1`, [shopId]);
    if (!row) throw shopNotFound();
    return row;
  }

  async saveShopInfo(client: PoolClient, shopId: string, input: unknown): Promise<ShopInfo> {
    const checked = validateShopInfo(input);
    if (!checked.ok) throw new ApiError(422, 'VALIDATION_FAILED', '입력값을 확인해 주세요.', { fields: checked.errors });
    const v = checked.value;
    const { rows: [row] } = await client.query<ShopInfo>(
      `UPDATE crm.shop_settings
          SET refund_policy = $2, naver_place_url = $3, instagram_url = $4, landing_url = $5, location_text = $6, updated_at = now()
        WHERE shop_id = $1
        RETURNING ${SHOP_INFO_COLUMNS}`,
      [shopId, v.refundPolicy, v.naverPlaceUrl, v.instagramUrl, v.landingUrl, v.locationText]);
    if (!row) throw shopNotFound();
    return row;
  }

  // ── 휴무 ──
  async closures(client: PoolClient, shopId: string): Promise<{ items: Closure[] }> {
    const { rows } = await client.query<ClosureRow>(
      `SELECT ${CLOSURE_COLUMNS} FROM crm.shop_closure WHERE shop_id = $1
        ORDER BY kind = 'weekly' DESC, weekday, start_date, created_at, id`, [shopId]);
    return { items: rows.map(toClosure) };
  }

  async addClosure(client: PoolClient, shopId: string, input: unknown): Promise<Closure> {
    const checked = validateClosure(input);
    if (!checked.ok) throw settingsInvalid(checked.error.code, checked.error.at);
    const note = noteOf(input);
    const c = checked.value;
    const { rows: [row] } = await client.query<ClosureRow>(
      `INSERT INTO crm.shop_closure (shop_id, kind, weekday, start_date, end_date, note)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${CLOSURE_COLUMNS}`,
      [shopId, c.kind, c.kind === 'weekly' ? c.weekday : null,
        c.kind === 'weekly' ? null : c.startDate, c.kind === 'weekly' ? null : c.endDate, note]);
    return toClosure(row!);
  }

  async removeClosure(client: PoolClient, shopId: string, closureId: string): Promise<void> {
    // 형식이 틀린 id도 "없음"으로 — 존재 여부와 같은 답을 준다.
    if (!UUID.test(closureId)) throw closureNotFound();
    const { rowCount } = await client.query('DELETE FROM crm.shop_closure WHERE shop_id = $1 AND id = $2', [shopId, closureId]);
    if (rowCount === 0) throw closureNotFound();
  }
}

const SHOP_INFO_COLUMNS = `refund_policy AS "refundPolicy", naver_place_url AS "naverPlaceUrl", instagram_url AS "instagramUrl",
  landing_url AS "landingUrl", location_text AS "locationText"`;
// date는 ::text로 꺼낸다 — pg가 JS Date(서버 시간대)로 바꾸면 하루가 밀릴 수 있다.
const CLOSURE_COLUMNS = 'id, kind, weekday, start_date::text AS start_date, end_date::text AS end_date, note';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ClosureRow {
  id: string;
  kind: 'weekly' | 'holiday' | 'vacation';
  weekday: number | null;
  start_date: string | null;
  end_date: string | null;
  note: string | null;
}

function toClosure(row: ClosureRow): Closure {
  return row.kind === 'weekly'
    ? { id: row.id, kind: 'weekly', weekday: row.weekday as 1 | 2 | 3 | 4 | 5 | 6 | 7, note: row.note }
    : { id: row.id, kind: row.kind, startDate: row.start_date!, endDate: row.end_date!, note: row.note };
}

function noteOf(input: unknown): string | null {
  const note = (input as { note?: unknown }).note;
  if (note === undefined || note === null) return null;
  if (typeof note !== 'string') throw settingsInvalid('INVALID_SHAPE', 'note');
  const text = note.trim();
  return text === '' ? null : text;
}

function settingsInvalid(reason: string, at?: string): ApiError<'SETTINGS_INVALID'> {
  return new ApiError(422, 'SETTINGS_INVALID', '설정 값을 확인해 주세요.', at === undefined ? { reason } : { reason, at });
}

function closureNotFound(): ApiError<'NOT_FOUND'> {
  return new ApiError(404, 'NOT_FOUND', '휴무를 찾을 수 없습니다.');
}
