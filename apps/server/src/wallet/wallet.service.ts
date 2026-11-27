import {
  signedDeltaFor, validateManualEntry, validatePassIssue,
  type EntryLabel, type UnitType,
} from '@bv/wallet';
import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { invalid } from '../appointments-m1/appointment-m1.service';
import { ApiError } from '../common/api-error';
import { lockShopWrites } from '../common/shop-lock';

// 공통 지갑 함수(설계 13 §2·§6, D3·D4·D6). 웹 수동 기록·CSV 이관·S6 완료 차감이 모두 여기로 들어온다.
// 모든 함수는 호출자의 매장 트랜잭션(withShop의 client)을 받는다. 쓰기는 먼저 lockShopWrites를 잡고(같은 트랜잭션에서
// 다시 잡아도 되는 잠금이라 S6·CSV가 이미 잡았어도 안전하다) 그 뒤 필요한 행을 FOR UPDATE로 잠근다.
// 잔액은 저장하지 않고 삭제 표시가 없는 원장 행의 합계로 계산한다. 음수도 그대로 돌려준다.

/** 어느 지갑 항목인가: 선불금(원) 또는 고객의 횟수권 하나. */
export type WalletItem = { unitType: 'amount' } | { unitType: 'sessions'; passId: string };

export interface WalletEntryRecord {
  id: string;
  customerId: string;
  unitType: UnitType;
  passId: string | null;
  label: EntryLabel;
  signedDelta: number;
  appointmentId: string | null;
  cycleSeq: number | null;
  memo: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  /** 이 거래를 적용한 직후 해당 항목의 잔액(원) 또는 잔여 횟수. */
  balanceAfter: number;
}

export interface CustomerPassRecord {
  id: string;
  customerId: string;
  name: string;
  menuId: string | null;
  menuName: string | null;
  remainingSessions: number;
  isPrimary: boolean;
  isActive: boolean;
  version: number;
}

/** 서버 내부 호출(CSV 등)용 횟수권 발급. 웹 입력은 validatePassIssue를 거쳐 menuId가 항상 있다. */
export interface PassIssue {
  customerId: string;
  name: string;
  menuId: string | null;
  sessions: number;
  isPrimary: boolean;
}

/** S6 완료 카드 승인 차감. 예약·완료 회차당 한 번만 기록된다. */
export interface CompletionDeduction {
  customerId: string;
  appointmentId: string;
  cycleSeq: number;
  item: WalletItem;
  /** 양수 크기(원 또는 횟수). 부호는 여기서 정한다. */
  value: number;
}

interface EntryWrite {
  customerId: string;
  item: WalletItem;
  label: EntryLabel;
  signedDelta: number;
  appointmentId?: string;
  cycleSeq?: number;
  memo?: string | null;
}

const ENTRY_COLUMNS = `id, customer_id, unit_type, pass_id, label, signed_delta, appointment_id, cycle_seq, memo, version, created_at, updated_at`;

@Injectable()
export class WalletService {
  /** 웹 결제·차감 기록(POST /api/wallet-entries 본문). 종류는 payment·deduct만, 부호는 서버가 정한다. */
  async recordManual(client: PoolClient, shopId: string, input: unknown): Promise<WalletEntryRecord> {
    const parsed = validateManualEntry(input);
    if (!parsed.ok) throw invalid(parsed.errors);
    const { customerId, unitType, passId, label, value, memo } = parsed.value;
    const item: WalletItem = unitType === 'sessions' ? { unitType, passId: passId! } : { unitType };
    return this.write(client, shopId, { customerId, item, label, signedDelta: signedDeltaFor(label, value)!, memo });
  }

  /** 웹 횟수권 구매·발급(POST /api/passes 본문). */
  async issuePassFromWeb(client: PoolClient, shopId: string, input: unknown): Promise<CustomerPassRecord> {
    const parsed = validatePassIssue(input);
    if (!parsed.ok) throw invalid(parsed.errors);
    return this.issuePass(client, shopId, parsed.value);
  }

  /**
   * 횟수권 행 + 첫 payment +N회를 호출자 트랜잭션 안에서 함께 기록한다(어느 쪽이 실패하면 함께 되돌아간다).
   * 메뉴를 연결하면 발급 당시 메뉴 이름을 남긴다. 새 대표를 고르면 같은 고객의 기존 활성 대표를 먼저 내린다.
   * 선불금은 건드리지 않는다(구매 금액은 지갑 거래가 아니다, 설계 13 §3).
   */
  async issuePass(client: PoolClient, shopId: string, pass: PassIssue): Promise<CustomerPassRecord> {
    if (signedDeltaFor('payment', pass.sessions) === null) throw invalid([{ field: 'sessions', code: 'INVALID_VALUE' }]);
    await lockShopWrites(client, shopId);
    await requireCustomer(client, shopId, pass.customerId);
    let menuName: string | null = null;
    if (pass.menuId !== null) {
      const { rows: [menu] } = await client.query<{ name: string }>(
        'SELECT name FROM crm.menu WHERE shop_id = $1 AND id = $2', [shopId, pass.menuId]);
      if (!menu) throw invalid([{ field: 'menuId', code: 'NOT_FOUND' }]);
      menuName = menu.name;
    }
    if (pass.isPrimary) {
      await client.query(
        'UPDATE crm.customer_pass SET is_primary = false WHERE shop_id = $1 AND customer_id = $2 AND is_primary AND is_active',
        [shopId, pass.customerId]);
    }
    const { rows: [row] } = await client.query<{ id: string }>(
      `INSERT INTO crm.customer_pass (shop_id, customer_id, name, menu_id, menu_name_snapshot, is_primary)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [shopId, pass.customerId, pass.name, pass.menuId, menuName, pass.isPrimary]);
    await this.write(client, shopId, {
      customerId: pass.customerId, item: { unitType: 'sessions', passId: row!.id }, label: 'payment', signedDelta: pass.sessions,
    });
    return (await findPass(client, shopId, row!.id))!;
  }

  /**
   * S6 완료 카드 승인 차감(D4). 예약이 같은 고객의 것인지 확인하고, 같은 예약·회차의 활성 차감이 이미 있으면 409.
   * 돌려주는 balanceAfter가 사후 문자에 쓸 확정 잔액·잔여 횟수다.
   * ASSUMPTION: 현재 완료 회차(cycleSeq)가 맞는지는 S6가 카드·예약 상태로 확인한다(회차 칸은 S6에서 추가).
   * 중복은 부분 유일 인덱스로도 막히지만, 그 오류는 호출자 트랜잭션을 깨뜨리므로 잠금 안에서 먼저 확인한다.
   */
  async deductForCompletion(client: PoolClient, shopId: string, deduction: CompletionDeduction): Promise<WalletEntryRecord> {
    const signedDelta = signedDeltaFor('deduct', deduction.value);
    if (signedDelta === null) throw invalid([{ field: 'value', code: 'INVALID_VALUE' }]);
    if (!Number.isInteger(deduction.cycleSeq) || deduction.cycleSeq < 1) throw invalid([{ field: 'cycleSeq', code: 'INVALID_VALUE' }]);
    await lockShopWrites(client, shopId);
    const { rows: [appointment] } = await client.query<{ customer_id: string }>(
      'SELECT customer_id FROM crm.appointment_m1 WHERE shop_id = $1 AND id = $2 FOR UPDATE', [shopId, deduction.appointmentId]);
    if (!appointment || appointment.customer_id !== deduction.customerId) {
      throw invalid([{ field: 'appointmentId', code: 'NOT_FOUND' }]);
    }
    const { rowCount } = await client.query(
      `SELECT 1 FROM crm.wallet_entry
        WHERE shop_id = $1 AND appointment_id = $2 AND cycle_seq = $3 AND label = 'deduct' AND deleted_at IS NULL`,
      [shopId, deduction.appointmentId, deduction.cycleSeq]);
    if (rowCount) {
      throw new ApiError(409, 'COMPLETION_ALREADY_DEDUCTED', '이 예약의 완료 차감이 이미 기록되었습니다.');
    }
    return this.write(client, shopId, {
      customerId: deduction.customerId, item: deduction.item, label: 'deduct', signedDelta,
      appointmentId: deduction.appointmentId, cycleSeq: deduction.cycleSeq,
    });
  }

  /**
   * S7 CSV 이관(D3). 부호를 그대로 보존하고, 0이면 거래를 만들지 않고 null을 돌려준다.
   * 같은 CSV 재업로드의 중복 방지는 S7의 가져오기 멱등에서 맡는다.
   */
  async recordOpeningBalance(
    client: PoolClient, shopId: string, opening: { customerId: string; item: WalletItem; value: number; memo?: string | null },
  ): Promise<WalletEntryRecord | null> {
    if (opening.value === 0) return null;
    const signedDelta = signedDeltaFor('opening_balance', opening.value);
    if (signedDelta === null) throw invalid([{ field: 'value', code: 'INVALID_VALUE' }]);
    return this.write(client, shopId, { customerId: opening.customerId, item: opening.item, label: 'opening_balance', signedDelta, memo: opening.memo });
  }

  /** 선불 잔액 또는 횟수권 잔여 횟수. 거래가 없으면 0, 음수 그대로. */
  async balance(client: PoolClient, shopId: string, customerId: string, item: WalletItem): Promise<number> {
    const { rows: [row] } = await client.query<{ total: string }>(
      `SELECT coalesce(sum(signed_delta), 0)::bigint AS total FROM crm.wallet_entry
        WHERE shop_id = $1 AND customer_id = $2 AND unit_type = $3 AND pass_id IS NOT DISTINCT FROM $4 AND deleted_at IS NULL`,
      [shopId, customerId, item.unitType, item.unitType === 'sessions' ? item.passId : null]);
    return Number(row!.total);
  }

  private async write(client: PoolClient, shopId: string, entry: EntryWrite): Promise<WalletEntryRecord> {
    await lockShopWrites(client, shopId);
    await requireCustomer(client, shopId, entry.customerId);
    const passId = entry.item.unitType === 'sessions' ? entry.item.passId : null;
    if (passId !== null) {
      const { rowCount } = await client.query(
        'SELECT 1 FROM crm.customer_pass WHERE shop_id = $1 AND customer_id = $2 AND id = $3 FOR UPDATE',
        [shopId, entry.customerId, passId]);
      if (!rowCount) throw invalid([{ field: 'passId', code: 'NOT_FOUND' }]);
    }
    const { rows: [row] } = await client.query<EntryRow>(
      `INSERT INTO crm.wallet_entry (shop_id, customer_id, unit_type, pass_id, label, signed_delta, appointment_id, cycle_seq, memo)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING ${ENTRY_COLUMNS}`,
      [shopId, entry.customerId, entry.item.unitType, passId, entry.label, entry.signedDelta,
        entry.appointmentId ?? null, entry.cycleSeq ?? null, entry.memo ?? null]);
    return toEntry(row!, await this.balance(client, shopId, entry.customerId, entry.item));
  }
}

async function requireCustomer(client: PoolClient, shopId: string, customerId: string): Promise<void> {
  const { rowCount } = await client.query('SELECT 1 FROM crm.customer WHERE shop_id = $1 AND id = $2', [shopId, customerId]);
  if (!rowCount) throw invalid([{ field: 'customerId', code: 'NOT_FOUND' }]);
}

async function findPass(client: PoolClient, shopId: string, id: string): Promise<CustomerPassRecord | null> {
  const { rows: [row] } = await client.query<{
    id: string; customer_id: string; name: string; menu_id: string | null; menu_name_snapshot: string | null;
    remaining: string; is_primary: boolean; is_active: boolean; version: number;
  }>(
    `SELECT p.id, p.customer_id, p.name, p.menu_id, p.menu_name_snapshot, p.is_primary, p.is_active, p.version,
            (SELECT coalesce(sum(e.signed_delta), 0)::bigint FROM crm.wallet_entry e
              WHERE e.shop_id = p.shop_id AND e.customer_id = p.customer_id AND e.pass_id = p.id AND e.deleted_at IS NULL) AS remaining
       FROM crm.customer_pass p WHERE p.shop_id = $1 AND p.id = $2`, [shopId, id]);
  if (!row) return null;
  return {
    id: row.id, customerId: row.customer_id, name: row.name, menuId: row.menu_id, menuName: row.menu_name_snapshot,
    remainingSessions: Number(row.remaining), isPrimary: row.is_primary, isActive: row.is_active, version: row.version,
  };
}

interface EntryRow {
  id: string; customer_id: string; unit_type: UnitType; pass_id: string | null; label: EntryLabel; signed_delta: number;
  appointment_id: string | null; cycle_seq: number | null; memo: string | null; version: number; created_at: Date; updated_at: Date;
}

function toEntry(row: EntryRow, balanceAfter: number): WalletEntryRecord {
  return {
    id: row.id, customerId: row.customer_id, unitType: row.unit_type, passId: row.pass_id, label: row.label,
    signedDelta: row.signed_delta, appointmentId: row.appointment_id, cycleSeq: row.cycle_seq, memo: row.memo,
    version: row.version, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(), balanceAfter,
  };
}
