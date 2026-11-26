import type { Menu, Staff } from '@bv/contracts';
import { validateMenu, validateStaff } from '@bv/scheduling/shop-settings';
import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApiError } from '../common/api-error';

// 메뉴·담당자(BEA-167). 예약을 넣을 때 고르는 목록이다. 지난 예약이 가리키므로 지우지 않고 active=false로 숨긴다.
// version·updated_at은 DB 트리거가 UPDATE마다 올린다(#43 010) — 여기서는 받은 version이 지금 값과 같은지만 본다.
// 모든 쿼리는 withShop 트랜잭션 안 + shop_id 조건(절대 규칙 5).
@Injectable()
export class CatalogService {
  // ── 메뉴 ──
  async menus(client: PoolClient, shopId: string, includeInactive: boolean): Promise<{ items: Menu[] }> {
    const { rows } = await client.query<Menu>(
      `SELECT ${MENU_COLUMNS} FROM crm.menu WHERE shop_id = $1 AND (active OR $2) ORDER BY created_at, id`,
      [shopId, includeInactive]);
    return { items: rows };
  }

  async addMenu(client: PoolClient, shopId: string, input: unknown): Promise<Menu> {
    const body = objectOf(input);
    const checked = validateMenu({
      name: body.name as string, defaultDurationMin: minutesOf(body.defaultDurationMin), defaultPrepMin: minutesOf(body.defaultPrepMin),
    });
    if (!checked.ok) throw invalid(checked.errors);
    const v = checked.value;
    const { rows: [row] } = await client.query<Menu>(
      `INSERT INTO crm.menu (shop_id, name, default_duration_min, default_cleanup_min)
       VALUES ($1, $2, $3, $4) RETURNING ${MENU_COLUMNS}`,
      [shopId, v.name, v.defaultDurationMin, v.defaultPrepMin]);
    return row!;
  }

  async updateMenu(client: PoolClient, shopId: string, menuId: string, input: unknown): Promise<Menu> {
    const body = objectOf(input);
    const current = await lockCurrent<Menu>(client, 'menu', MENU_COLUMNS, shopId, menuId, body.version);
    // 보낸 칸만 바꾼다(null은 비우기). 합친 값을 #39 검사에 그대로 넣어 등록과 같은 규칙을 쓴다.
    const checked = validateMenu({
      name: (has(body, 'name') ? body.name : current.name) as string,
      defaultDurationMin: has(body, 'defaultDurationMin') ? minutesOf(body.defaultDurationMin) : current.defaultDurationMin,
      defaultPrepMin: has(body, 'defaultPrepMin') ? minutesOf(body.defaultPrepMin) : current.defaultPrepMin,
    });
    const errors = checked.ok ? [] : [...checked.errors];
    const active = activeOf(body, current.active, errors);
    if (!checked.ok || errors.length > 0) throw invalid(errors);
    const v = checked.value;
    const { rows: [row] } = await client.query<Menu>(
      `UPDATE crm.menu SET name = $3, default_duration_min = $4, default_cleanup_min = $5, active = $6
        WHERE shop_id = $1 AND id = $2 RETURNING ${MENU_COLUMNS}`,
      [shopId, menuId, v.name, v.defaultDurationMin, v.defaultPrepMin, active]);
    return row!;
  }

  // ── 담당자 ──
  async staff(client: PoolClient, shopId: string, includeInactive: boolean): Promise<{ items: Staff[] }> {
    const { rows } = await client.query<Staff>(
      `SELECT ${STAFF_COLUMNS} FROM crm.staff WHERE shop_id = $1 AND (active OR $2) ORDER BY created_at, id`,
      [shopId, includeInactive]);
    return { items: rows };
  }

  /** 원장 자신도 담당자로 등록할 수 있다 — 담당자는 로그인 계정이 아니라 예약을 맡는 이름이다(파생 R20). */
  async addStaff(client: PoolClient, shopId: string, input: unknown): Promise<Staff> {
    const checked = validateStaff({ name: objectOf(input).name as string });
    if (!checked.ok) throw invalid(checked.errors);
    const { rows: [row] } = await client.query<Staff>(
      `INSERT INTO crm.staff (shop_id, name) VALUES ($1, $2) RETURNING ${STAFF_COLUMNS}`, [shopId, checked.value.name]);
    return row!;
  }

  async updateStaff(client: PoolClient, shopId: string, staffId: string, input: unknown): Promise<Staff> {
    const body = objectOf(input);
    const current = await lockCurrent<Staff>(client, 'staff', STAFF_COLUMNS, shopId, staffId, body.version);
    const checked = validateStaff({ name: (has(body, 'name') ? body.name : current.name) as string });
    const errors = checked.ok ? [] : [...checked.errors];
    const active = activeOf(body, current.active, errors);
    if (!checked.ok || errors.length > 0) throw invalid(errors);
    // 숨겨도 이미 잡힌 예약은 그대로 둔다(계약 #42). 숨긴 담당자로 새 예약을 막는 건 예약 쓰기(BEA-177).
    const { rows: [row] } = await client.query<Staff>(
      `UPDATE crm.staff SET name = $3, active = $4 WHERE shop_id = $1 AND id = $2 RETURNING ${STAFF_COLUMNS}`,
      [shopId, staffId, checked.value.name, active]);
    return row!;
  }
}

const META = 'id, version, created_at AS "createdAt", updated_at AS "updatedAt"';
const MENU_COLUMNS = `${META}, name, default_duration_min AS "defaultDurationMin", default_cleanup_min AS "defaultPrepMin", active`;
const STAFF_COLUMNS = `${META}, name, active`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type FieldError = { field: string; code: string };

/**
 * 고칠 행을 잠그고(FOR UPDATE) 가져온다. 없으면 404, 받은 version이 지금 값과 다르면 409.
 * 잠가 두므로 확인과 UPDATE 사이에 다른 요청이 끼어들 수 없다.
 */
async function lockCurrent<T extends { version: number }>(
  client: PoolClient, table: 'menu' | 'staff', columns: string, shopId: string, id: string, version: unknown,
): Promise<T> {
  if (!Number.isInteger(version) || (version as number) < 1) throw invalid([{ field: 'version', code: 'REQUIRED' }]);
  if (!UUID.test(id)) throw notFound(table);
  const { rows: [row] } = await client.query<T>(
    `SELECT ${columns} FROM crm.${table} WHERE shop_id = $1 AND id = $2 FOR UPDATE`, [shopId, id]);
  if (!row) throw notFound(table);
  if (row.version !== version) {
    throw new ApiError(409, 'VERSION_CONFLICT', '다른 화면에서 먼저 바뀌었습니다. 새로 불러와 주세요.', { currentVersion: row.version });
  }
  return row;
}

function activeOf(body: Record<string, unknown>, current: boolean, errors: FieldError[]): boolean {
  if (!has(body, 'active')) return current;
  if (typeof body.active !== 'boolean') errors.push({ field: 'active', code: 'INVALID_BOOLEAN' });
  return body.active === true;
}

function objectOf(input: unknown): Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
}

function has(body: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, key) && body[key] !== undefined;
}

// 숫자가 아닌 값은 NaN으로 넘겨 #39 검사가 INVALID_MINUTES로 거부하게 한다.
function minutesOf(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  return typeof value === 'number' ? value : Number.NaN;
}

function invalid(errors: readonly FieldError[]): ApiError<'VALIDATION_FAILED'> {
  return new ApiError(422, 'VALIDATION_FAILED', '입력값을 확인해 주세요.', { fields: errors });
}

function notFound(table: 'menu' | 'staff'): ApiError<'NOT_FOUND'> {
  return new ApiError(404, 'NOT_FOUND', table === 'menu' ? '메뉴를 찾을 수 없습니다.' : '담당자를 찾을 수 없습니다.');
}
