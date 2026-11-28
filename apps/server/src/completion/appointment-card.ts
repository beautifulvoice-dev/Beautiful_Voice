import type { PoolClient } from 'pg';

/** 매장 쓰기 잠금 안에서 호출한다. 예약 행보다 미승인 카드 행을 먼저 잠근다. */
export async function lockPendingCompletion(client: PoolClient, shopId: string, appointmentId: string): Promise<string | undefined> {
  const { rows: [card] } = await client.query<{ id: string }>(
    `SELECT id FROM crm.action_cards
      WHERE shop_id = $1 AND appointment_id = $2 AND kind = 'completion_cycle' AND status = 'pending'
      FOR UPDATE`,
    [shopId, appointmentId],
  );
  return card?.id;
}

export async function dismissPendingCompletion(
  client: PoolClient, shopId: string, cardId: string, reason: 'rescheduled' | 'status_changed',
): Promise<void> {
  await client.query(
    `UPDATE crm.action_cards
        SET status = 'dismissed', dismiss_reason = $3, resolved_at = clock_timestamp()
      WHERE shop_id = $1 AND id = $2 AND kind = 'completion_cycle' AND status = 'pending'`,
    [shopId, cardId, reason],
  );
}
