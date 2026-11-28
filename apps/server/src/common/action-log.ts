import type { PoolClient } from 'pg';

type ActionEvent =
  | { eventType: 'pre_visit_dispatch' | 'post_visit_dispatch'; resultCode: 'provider_halt' | 'quiet_hours' | 'rate_limited' | 'accepted' | 'failed' | 'unknown' | 'retry_scheduled' }
  | { eventType: 'completion_promotion'; resultCode: 'skipped' | 'overdue' }
  | { eventType: 'completion_approval'; resultCode: 'approved' | 'target_changed' };

interface ActionTraceEvent {
  eventId: string;
  causationId: string | null;
  eventType: string;
  resultCode: string;
  recordedAt: Date;
}

/** Use the caller's shop-scoped transaction so the event rolls back with its action. */
export async function recordActionLog(
  client: PoolClient,
  shopId: string,
  traceId: string,
  { eventType, resultCode }: ActionEvent,
  causationId: string | null = null,
): Promise<string> {
  const { rows: [inserted] } = await client.query<{ id: string }>(`
    INSERT INTO crm.action_logs (shop_id, trace_id, causation_id, event_type, result_code)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING id`, [shopId, traceId, causationId, eventType, resultCode]);
  return inserted!.id;
}

/** Internal trace query. The transaction and the WHERE clause must use the same authorized shop. */
export async function readActionTrace(client: PoolClient, shopId: string, traceId: string): Promise<ActionTraceEvent[]> {
  const { rows } = await client.query<ActionTraceEvent>(`
    WITH RECURSIVE recent AS MATERIALIZED (
      SELECT id, causation_id, event_type, result_code, recorded_at
      FROM crm.action_logs
      WHERE shop_id = $1 AND trace_id = $2 AND recorded_at >= statement_timestamp() - interval '90 days'
    ), trace AS (
      SELECT event.*, 0 AS depth
      FROM recent event
      WHERE NOT EXISTS (SELECT 1 FROM recent parent WHERE parent.id = event.causation_id)
      UNION ALL
      SELECT event.*, parent.depth + 1
      FROM recent event JOIN trace parent ON parent.id = event.causation_id
    )
    SELECT id AS "eventId", causation_id AS "causationId", event_type AS "eventType",
      result_code AS "resultCode", recorded_at AS "recordedAt"
    FROM trace ORDER BY depth, recorded_at, id`, [shopId, traceId]);
  return rows;
}
