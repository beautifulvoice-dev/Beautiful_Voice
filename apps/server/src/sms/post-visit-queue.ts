import { normalizePhone } from '@bv/customers';
import type { PoolClient } from 'pg';
import { renderSmsTemplate, type SmsTemplateSlot } from './sms-template';

type ConfirmedDeduction =
  | { kind: 'none' }
  | { kind: 'amount'; amount: number; walletBalance: number }
  | { kind: 'sessions'; sessions: number; remainingSessions: number; passName: string; walletBalance?: number };

type PostVisitQueueResult =
  | { outcome: 'queued'; messageId: string }
  | { outcome: 'already_queued' }
  | { outcome: 'needs_input'; reason: 'missing_phone' | 'invalid_phone' | 'missing_template' | 'invalid_template'; templateCode?: string }
  | { outcome: 'skipped'; reason: 'opted_out' | 'landline' | 'inactive_customer' };

const slotByDeduction = {
  none: 'post_general', amount: 'post_amount', sessions: 'post_session',
} as const satisfies Record<ConfirmedDeduction['kind'], SmsTemplateSlot>;

/** Invoke after resolving the approved card, completing the appointment and applying any debit in the same shop transaction. */
export async function queueApprovedPostVisit(
  client: PoolClient,
  shopId: string,
  { appointmentId, cardId, deduction }: { appointmentId: string; cardId: string; deduction: ConfirmedDeduction },
): Promise<PostVisitQueueResult> {
  const slot = slotByDeduction[deduction.kind];
  const { rows: [snapshot] } = await client.query<{
    customer_id: string;
    cycle_seq: number;
    customer_name: string;
    phone: string | null;
    sms_opt_out: boolean;
    active: boolean;
    start_at: Date;
    menu_name_snapshot: string | null;
    shop_name: string;
    shop_location: string | null;
    template_body: string | null;
    already_queued: boolean;
  }>(`
    SELECT a.customer_id, a.cycle_seq, a.start_at, a.menu_name_snapshot,
      c.name AS customer_name, c.phone, c.sms_opt_out, c.active,
      s.name AS shop_name, template.body AS template_body,
      concat_ws(' ', nullif(btrim(settings.location_text), ''), nullif(btrim(settings.naver_place_url), '')) AS shop_location,
      EXISTS (SELECT 1 FROM crm.sms_messages m WHERE m.shop_id = a.shop_id AND m.action_card_id = card.id) AS already_queued
    FROM crm.appointment_m1 a
    JOIN crm.action_cards card ON card.shop_id = a.shop_id AND card.appointment_id = a.id
      AND card.customer_id = a.customer_id AND card.cycle_seq = a.cycle_seq
    JOIN crm.customer c ON c.shop_id = a.shop_id AND c.id = a.customer_id
    JOIN crm.shop s ON s.id = a.shop_id
    LEFT JOIN crm.shop_settings settings ON settings.shop_id = a.shop_id
    LEFT JOIN crm.sms_templates template ON template.shop_id = a.shop_id AND template.template_key = $4
    WHERE a.shop_id = $1 AND a.id = $2 AND card.id = $3 AND a.status = 'completed'
      AND card.kind = 'completion_cycle' AND card.status = 'resolved'`, [shopId, appointmentId, cardId, slot]);
  if (!snapshot) throw new Error('Post-visit message requires the approved card for the completed appointment');
  if (snapshot.already_queued) return { outcome: 'already_queued' };
  if (snapshot.sms_opt_out) return { outcome: 'skipped', reason: 'opted_out' };
  if (!snapshot.active) return { outcome: 'skipped', reason: 'inactive_customer' };
  if (!snapshot.phone) return { outcome: 'needs_input', reason: 'missing_phone' };
  const recipient = normalizePhone(snapshot.phone);
  if (!recipient.ok) return { outcome: 'needs_input', reason: 'invalid_phone' };
  if (recipient.kind !== 'mobile') return { outcome: 'skipped', reason: 'landline' };
  if (!snapshot.template_body) return { outcome: 'needs_input', reason: 'missing_template' };

  const rendered = renderSmsTemplate(slot, snapshot.template_body, {
    customerName: snapshot.customer_name,
    appointmentStart: snapshot.start_at,
    menuName: snapshot.menu_name_snapshot,
    shopName: snapshot.shop_name,
    shopLocation: snapshot.shop_location,
    walletBalance: deduction.kind !== 'none' ? deduction.walletBalance : undefined,
    deductedAmount: deduction.kind === 'amount' ? deduction.amount : undefined,
    deductedSessions: deduction.kind === 'sessions' ? deduction.sessions : undefined,
    remainingSessions: deduction.kind === 'sessions' ? deduction.remainingSessions : undefined,
    passName: deduction.kind === 'sessions' ? deduction.passName : undefined,
  });
  if (!rendered.ok) return { outcome: 'needs_input', reason: 'invalid_template', templateCode: rendered.error.code };

  const message = rendered.value;
  const { rows: [created] } = await client.query<{ id: string }>(`
    INSERT INTO crm.sms_messages
      (shop_id, customer_id, appointment_id, action_card_id, operation_key, kind, status, scheduled_at,
       recipient_phone, rendered_body, byte_length, message_type, lms_title)
    VALUES ($1,$2,$3,$4,$5,'post_visit_approved','queued',clock_timestamp(),$6,$7,$8,$9,$10)
    ON CONFLICT (shop_id, operation_key) DO NOTHING RETURNING id`, [
    shopId, snapshot.customer_id, appointmentId, cardId, `post_visit_${appointmentId}_${snapshot.cycle_seq}`,
    recipient.phone, message.body, message.byteLength, message.messageType,
    message.messageType === 'LMS' ? message.title : null,
  ]);
  return created ? { outcome: 'queued', messageId: created.id } : { outcome: 'already_queued' };
}
