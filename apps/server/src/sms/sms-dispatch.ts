import { normalizePhone } from '@bv/customers';
import type { PoolClient } from 'pg';
import { recordActionLog } from '../common/action-log';
import { lockShopWrites } from '../common/shop-lock';
import type { DatabaseService } from '../database.service';
import { preVisitDispatchTiming } from './pre-visit-schedule';

interface SmsDelivery {
  id: string;
  recipient: string;
  body: string;
  type: 'SMS' | 'LMS';
  title: string | null;
}

export type Deliver = (message: SmsDelivery) => Promise<
  | { status: 'sent'; providerId: string }
  | { status: 'failed' | 'unknown' | 'not_accepted' | 'halt' }
>;

interface DueMessage extends SmsDelivery {
  kind: 'pre_visit_auto' | 'post_visit_approved';
  pendingStatus: 'scheduled' | 'queued';
  startAt: Date;
  timezone: string;
  version: number;
  retryCount: number;
  quotaReservedAt: Date | null;
  validAppointment: boolean;
  eligibleCustomer: boolean;
  currentPhone: string | null;
}

const retriesInMinutes = [1, 5, 15];

export async function dispatchSmsForShop(
  db: Pick<DatabaseService, 'withSystem'>,
  shopId: string,
  deliver: Deliver,
  {
    clock = () => new Date(),
    shouldContinue = () => true,
    testRecipient = null,
  }: { clock?: () => Date; shouldContinue?: () => boolean; testRecipient?: string | null } = {},
): Promise<void | 'halt'> {
  const inShop = <T>(run: (client: PoolClient) => Promise<T>) => db.withSystem(async (client) => {
    await client.query("SELECT set_config('app.shop_id', $1::uuid::text, true)", [shopId]);
    return run(client);
  });

  await inShop(async (client) => {
    await client.query(`
      UPDATE crm.sms_messages SET status = 'unknown'
       WHERE shop_id = $1 AND kind IN ('pre_visit_auto', 'post_visit_approved') AND status = 'sending'
         AND claimed_at <= $2::timestamptz - interval '5 minutes'
         AND ($3::text IS NULL OR recipient_phone = $3)`, [shopId, clock(), testRecipient]);
  });

  for (let checked = 0; checked < 50 && shouldContinue(); checked++) {
    const claim = await inShop(async (client) => {
      await lockShopWrites(client, shopId);
      return claimDueSms(client, shopId, clock(), testRecipient);
    });
    if (claim === null) return;
    if (!claim) continue;

    const { id, recipient, body, type, title, version, retryCount, pendingStatus } = claim;
    let result: Awaited<ReturnType<Deliver>>;
    try {
      result = await deliver({ id, recipient, body, type, title });
    } catch {
      result = { status: 'unknown' };
    }
    const retryDelay = result.status === 'not_accepted' ? retriesInMinutes[retryCount] : undefined;
    const outcome = retryDelay || result.status === 'halt'
      ? pendingStatus
      : result.status === 'not_accepted' ? 'failed' : result.status;
    await inShop(async (client) => {
      if (result.status === 'halt') await lockShopWrites(client, shopId);
      const { rows: [settled] } = await client.query(`
        UPDATE crm.sms_messages SET status = $4, provider_message_id = $5,
          scheduled_at = CASE WHEN $6::integer IS NULL THEN scheduled_at ELSE $7::timestamptz + make_interval(mins => $6) END,
          retry_count = retry_count + CASE WHEN $6::integer IS NULL THEN 0 ELSE 1 END
         WHERE shop_id = $1 AND id = $2 AND version = $3 AND status = 'sending' RETURNING id`,
      [shopId, id, version, outcome, result.status === 'sent' ? result.providerId : null, retryDelay ?? null, clock()]);
      const eventType = claim.kind === 'pre_visit_auto' ? 'pre_visit_dispatch' : 'post_visit_dispatch';
      if (result.status === 'halt') {
        const { rows } = await client.query(
          'UPDATE crm.shop_settings SET sms_paused_at = $2 WHERE shop_id = $1 AND sms_paused_at IS NULL RETURNING shop_id',
          [shopId, clock()],
        );
        if (rows.length) {
          await recordActionLog(client, shopId, id, { eventType, resultCode: 'provider_halt' });
        }
      } else if (settled) {
        const resultCode = retryDelay ? 'retry_scheduled'
          : result.status === 'sent' ? 'accepted'
          : result.status === 'unknown' ? 'unknown' : 'failed';
        await recordActionLog(client, shopId, id, { eventType, resultCode });
      }
    });
    if (result.status === 'halt') return 'halt';
  }
}

async function claimDueSms(client: PoolClient, shopId: string, now: Date, testRecipient: string | null): Promise<DueMessage | false | null> {
  const { rows: [due] } = await client.query<DueMessage>(`
    SELECT m.id, m.recipient_phone AS recipient, m.rendered_body AS body, m.message_type AS type, m.lms_title AS title,
      m.kind, m.status AS "pendingStatus", m.version, m.retry_count AS "retryCount", m.quota_reserved_at AS "quotaReservedAt",
      a.start_at AS "startAt", s.timezone, c.phone AS "currentPhone",
      (a.customer_id = m.customer_id AND CASE m.kind
        WHEN 'pre_visit_auto' THEN a.status = 'scheduled' AND a.start_at = m.appointment_start_at
        WHEN 'post_visit_approved' THEN a.status = 'completed' AND card.status = 'resolved' AND card.cycle_seq = a.cycle_seq
      END) AS "validAppointment",
      (c.active AND NOT c.sms_opt_out) AS "eligibleCustomer"
      FROM crm.sms_messages m
      JOIN crm.appointment_m1 a ON a.shop_id = m.shop_id AND a.id = m.appointment_id
      JOIN crm.customer c ON c.shop_id = m.shop_id AND c.id = m.customer_id
      LEFT JOIN crm.action_cards card ON card.shop_id = m.shop_id AND card.id = m.action_card_id
      JOIN crm.shop s ON s.id = m.shop_id
      JOIN crm.shop_settings settings ON settings.shop_id = m.shop_id AND settings.sms_paused_at IS NULL
     WHERE m.shop_id = $1 AND m.scheduled_at <= $2
       AND ($3::text IS NULL OR m.recipient_phone = $3)
       AND ((m.kind = 'pre_visit_auto' AND m.status = 'scheduled')
         OR (m.kind = 'post_visit_approved' AND m.status = 'queued' AND m.action_card_id IS NOT NULL))
     ORDER BY m.scheduled_at, m.id LIMIT 1 FOR UPDATE OF m`, [shopId, now, testRecipient]);
  if (!due) return null;

  const phone = due.currentPhone && normalizePhone(due.currentPhone);
  let status: string = 'sending';
  let scheduledAt: Date | null = null;
  let event: 'quiet_hours' | 'rate_limited' | null = null;
  if (!due.validAppointment || !due.eligibleCustomer || !phone || !phone.ok ||
      phone.kind !== 'mobile' || phone.phone !== due.recipient) {
    status = 'cancelled';
  } else if (due.kind === 'pre_visit_auto') {
    const timing = await preVisitDispatchTiming(client, { startAt: due.startAt, now, timezone: due.timezone });
    if (timing.status === 'deferred') {
      status = 'scheduled';
      scheduledAt = timing.scheduledAt;
      event = 'quiet_hours';
    } else if (timing.status === 'skipped_last_minute') {
      status = timing.status;
    }
  }
  if (status === 'sending' && !due.quotaReservedAt) {
    const { rows: [quota] } = await client.query<{ limited: boolean; nextMorning: Date }>(`
        WITH local_day AS (SELECT ($2::timestamptz AT TIME ZONE $3::text)::date AS day)
        SELECT (SELECT count(*) >= 100 OR count(*) FILTER (WHERE recipient_phone = $4) >= 4
                  FROM crm.sms_messages
                 WHERE shop_id = $1 AND quota_reserved_at >= day::timestamp AT TIME ZONE $3::text
                   AND quota_reserved_at < (day + 1)::timestamp AT TIME ZONE $3::text) AS limited,
          (day + 1 + time '08:00') AT TIME ZONE $3::text AS "nextMorning"
        FROM local_day`, [shopId, now, due.timezone, due.recipient]);
    if (quota!.limited) {
      event = 'rate_limited';
      if (due.kind === 'post_visit_approved') {
        status = 'blocked_rate_limited';
      } else if (quota!.nextMorning.getTime() <= due.startAt.getTime() - 30 * 60_000) {
        status = 'scheduled';
        scheduledAt = quota!.nextMorning;
      } else {
        status = 'skipped_last_minute';
      }
    }
  }

  const { rows: [updated] } = await client.query<{ version: number }>(`
    UPDATE crm.sms_messages SET status = $4, scheduled_at = coalesce($5, scheduled_at),
      claimed_at = CASE WHEN $4 = 'sending' THEN $6 ELSE claimed_at END,
      quota_reserved_at = CASE WHEN $4 = 'sending' THEN coalesce(quota_reserved_at, $6) ELSE quota_reserved_at END
     WHERE shop_id = $1 AND id = $2 AND version = $3 AND status = $7 RETURNING version`,
  [shopId, due.id, due.version, status, scheduledAt, now, due.pendingStatus]);
  if (updated && event) {
    await recordActionLog(client, shopId, due.id, { eventType: due.kind === 'pre_visit_auto' ? 'pre_visit_dispatch' : 'post_visit_dispatch', resultCode: event });
  }
  return updated && status === 'sending' ? { ...due, version: updated.version } : false;
}
