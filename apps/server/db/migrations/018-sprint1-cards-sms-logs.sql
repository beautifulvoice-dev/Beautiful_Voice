-- Sprint 1 cards, SMS and logs, after the customer and S4 wallet migrations.
-- The approval service locks and validates the card, checks the wallet, updates the
-- appointment, posts any debit, and queues any eligible message in one transaction.
-- Use WalletService.deductForCompletion with the card's appointment_id and cycle_seq.
-- S4's wallet_entry_one_deduct_per_cycle guards the debit, and action_card_id guards the SMS.
-- The worker calls the provider after commit. Unknown outcomes require reconciliation
-- and must not be treated as safe retries.

-- The service checks the current customer and appointment version on creation and
-- approval. Customer IDs in the new rows are snapshots so appointment edits still work.

ALTER TABLE crm.shop_settings
  ADD COLUMN pre_visit_hours integer NOT NULL DEFAULT 24 CHECK (pre_visit_hours BETWEEN 1 AND 168),
  ADD COLUMN sms_paused_at timestamptz;

ALTER TABLE crm.appointment_m1
  ADD COLUMN cycle_seq integer NOT NULL DEFAULT 1 CHECK (cycle_seq >= 1);
GRANT UPDATE (cycle_seq) ON crm.appointment_m1 TO bv_app;

CREATE TABLE crm.action_cards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  appointment_id uuid NOT NULL,
  appointment_version integer NOT NULL CHECK (appointment_version >= 1),
  cycle_seq integer NOT NULL DEFAULT 1 CHECK (cycle_seq >= 1),
  kind text NOT NULL DEFAULT 'completion_cycle' CHECK (kind IN ('completion_cycle')),
  priority_rank integer NOT NULL DEFAULT 100,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved', 'dismissed', 'failed')),
  failure_reason text CHECK (btrim(failure_reason) <> ''),
  dismiss_reason text CHECK (dismiss_reason IN ('user', 'rescheduled', 'status_changed', 'recording_hidden', 'reverted')),
  available_at timestamptz NOT NULL,
  resolved_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (shop_id, customer_id, appointment_id, id),
  UNIQUE (shop_id, kind, appointment_id, cycle_seq),
  CHECK ((status = 'pending') = (resolved_at IS NULL)),
  CHECK ((status = 'failed') = (failure_reason IS NOT NULL)),
  CHECK ((status = 'dismissed') = (dismiss_reason IS NOT NULL)),
  FOREIGN KEY (shop_id, customer_id) REFERENCES crm.customer (shop_id, id),
  FOREIGN KEY (shop_id, appointment_id) REFERENCES crm.appointment_m1 (shop_id, id)
);

CREATE UNIQUE INDEX action_cards_one_active_completion_by_appointment
  ON crm.action_cards (shop_id, appointment_id)
  WHERE kind = 'completion_cycle' AND status = 'pending';

CREATE INDEX action_cards_pending_by_shop ON crm.action_cards (shop_id, available_at, id)
  WHERE status = 'pending';

CREATE TABLE crm.sms_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES crm.shop (id),
  template_key text NOT NULL CHECK (btrim(template_key) <> ''),
  body text NOT NULL CHECK (btrim(body) <> ''),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (shop_id, template_key)
);

CREATE TABLE crm.sms_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  appointment_id uuid,
  action_card_id uuid,
  operation_key text NOT NULL CHECK (btrim(operation_key) <> ''),
  kind text NOT NULL DEFAULT 'post_visit_approved' CHECK (kind IN ('pre_visit_auto', 'post_visit_approved')),
  rendered_body text CHECK (btrim(rendered_body) <> ''),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('scheduled', 'queued', 'sending', 'sent', 'failed', 'unknown', 'cancelled',
      'skipped_last_minute', 'blocked_missing_vars', 'blocked_rate_limited')),
  scheduled_at timestamptz NOT NULL,
  appointment_start_at timestamptz,
  quiet_hour_adjusted boolean NOT NULL DEFAULT false,
  recipient_phone text,
  byte_length integer CHECK (byte_length BETWEEN 1 AND 2000),
  message_type text CHECK (message_type IN ('SMS', 'LMS')),
  lms_title text CHECK (char_length(lms_title) BETWEEN 1 AND 40),
  provider_message_id text,
  claimed_at timestamptz,
  quota_reserved_at timestamptz,
  retry_count integer NOT NULL DEFAULT 0 CHECK (retry_count BETWEEN 0 AND 3),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (shop_id, operation_key),
  UNIQUE (shop_id, action_card_id),
  CHECK (action_card_id IS NULL OR appointment_id IS NOT NULL),
  CHECK (kind <> 'pre_visit_auto' OR
    (appointment_id IS NOT NULL AND appointment_start_at IS NOT NULL AND action_card_id IS NULL AND recipient_phone IS NOT NULL)),
  CHECK (rendered_body IS NOT NULL OR
    (kind = 'pre_visit_auto' AND status IN ('skipped_last_minute', 'blocked_missing_vars', 'cancelled'))),
  CHECK (kind <> 'pre_visit_auto' OR status <> 'scheduled' OR
    (byte_length IS NOT NULL AND message_type IS NOT NULL AND
      ((message_type = 'SMS' AND byte_length <= 90 AND lms_title IS NULL)
        OR (message_type = 'LMS' AND byte_length > 90 AND lms_title IS NOT NULL)))),
  FOREIGN KEY (shop_id, customer_id) REFERENCES crm.customer (shop_id, id),
  FOREIGN KEY (shop_id, appointment_id) REFERENCES crm.appointment_m1 (shop_id, id),
  FOREIGN KEY (shop_id, customer_id, appointment_id, action_card_id)
    REFERENCES crm.action_cards (shop_id, customer_id, appointment_id, id)
);

CREATE INDEX sms_messages_due_by_shop ON crm.sms_messages (shop_id, scheduled_at, id)
  WHERE status IN ('scheduled', 'queued');

-- Keep reservations across retries and ambiguous outcomes.
CREATE INDEX sms_messages_quota_by_shop ON crm.sms_messages (shop_id, quota_reserved_at)
  WHERE quota_reserved_at IS NOT NULL;

CREATE TABLE crm.action_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES crm.shop (id),
  trace_id uuid NOT NULL,
  causation_id uuid,
  event_type text NOT NULL CHECK (btrim(event_type) <> ''),
  result_code text NOT NULL CHECK (btrim(result_code) <> ''),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (shop_id, trace_id, id),
  FOREIGN KEY (shop_id, trace_id, causation_id)
    REFERENCES crm.action_logs (shop_id, trace_id, id) ON DELETE SET NULL (causation_id)
);

CREATE INDEX action_logs_by_trace ON crm.action_logs (shop_id, trace_id, recorded_at, id);
CREATE INDEX action_logs_by_cause ON crm.action_logs (shop_id, trace_id, causation_id) WHERE causation_id IS NOT NULL;
CREATE INDEX action_logs_by_expiry ON crm.action_logs (shop_id, recorded_at, id);

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'action_cards', 'sms_templates', 'sms_messages', 'action_logs'
  ] LOOP
    EXECUTE format('ALTER TABLE crm.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE crm.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY shop_scope ON crm.%I
       USING (shop_id = nullif(current_setting(''app.shop_id'', true), '''')::uuid)
       WITH CHECK (shop_id = nullif(current_setting(''app.shop_id'', true), '''')::uuid)',
      table_name
    );
  END LOOP;

  FOREACH table_name IN ARRAY ARRAY['action_cards', 'sms_templates', 'sms_messages'] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON crm.%I
       FOR EACH ROW EXECUTE FUNCTION crm.bump_m1_reference_version()',
      table_name || '_next_version', table_name
    );
  END LOOP;
END
$$;

GRANT SELECT ON crm.action_cards,
  crm.sms_templates, crm.sms_messages, crm.action_logs TO bv_app;
GRANT UPDATE (status, resolved_at, failure_reason, dismiss_reason, appointment_version, available_at) ON crm.action_cards TO bv_app;
GRANT UPDATE (body) ON crm.sms_templates TO bv_app;
GRANT INSERT (shop_id, customer_id, appointment_id, action_card_id, operation_key, kind, status, scheduled_at,
  appointment_start_at, quiet_hour_adjusted, recipient_phone, rendered_body, byte_length, message_type, lms_title)
  ON crm.sms_messages TO bv_app;
GRANT UPDATE (customer_id, status, scheduled_at, appointment_start_at, quiet_hour_adjusted,
  recipient_phone, rendered_body, byte_length, message_type, lms_title) ON crm.sms_messages TO bv_app;
CREATE POLICY reschedule_pre_visit_only ON crm.sms_messages AS RESTRICTIVE FOR UPDATE TO bv_app
  USING (kind = 'pre_visit_auto' AND status IN ('scheduled', 'skipped_last_minute', 'cancelled', 'blocked_missing_vars'))
  WITH CHECK (kind = 'pre_visit_auto' AND status IN ('scheduled', 'skipped_last_minute', 'cancelled', 'blocked_missing_vars'));
GRANT INSERT (shop_id, trace_id, causation_id, event_type, result_code) ON crm.action_logs TO bv_app;

-- Provision templates for one new shop in the transaction that set app.shop_id.
GRANT INSERT (shop_id, template_key, body) ON crm.sms_templates TO bv_provision;

-- Workers enumerate shop IDs, then process private rows in one shop per transaction.
CREATE POLICY system_shop_index ON crm.shop FOR SELECT TO bv_system USING (true);
GRANT SELECT (id, timezone) ON crm.shop TO bv_system;
GRANT SELECT (shop_id, sms_paused_at), UPDATE (sms_paused_at) ON crm.shop_settings TO bv_system;
GRANT SELECT (id, shop_id, phone, sms_opt_out, active) ON crm.customer TO bv_system;
GRANT SELECT (id, shop_id, customer_id, menu_id, start_at, duration_min, status, version, cycle_seq)
  ON crm.appointment_m1 TO bv_system;
GRANT SELECT ON crm.action_cards, crm.sms_messages TO bv_system;
GRANT INSERT (shop_id, customer_id, appointment_id, appointment_version, cycle_seq, kind, available_at)
  ON crm.action_cards TO bv_system;
GRANT UPDATE (customer_id, appointment_version, available_at, status, resolved_at, dismiss_reason)
  ON crm.action_cards TO bv_system;
CREATE POLICY system_resume_rescheduled_completion ON crm.action_cards AS RESTRICTIVE FOR UPDATE TO bv_system
  USING (kind = 'completion_cycle' AND status = 'dismissed' AND dismiss_reason = 'rescheduled')
  WITH CHECK (
    kind = 'completion_cycle' AND status = 'pending' AND dismiss_reason IS NULL AND resolved_at IS NULL
    AND EXISTS (
      SELECT 1 FROM crm.appointment_m1 a
       WHERE a.shop_id = action_cards.shop_id AND a.id = action_cards.appointment_id
         AND a.status = 'scheduled' AND a.customer_id = action_cards.customer_id
         AND a.cycle_seq = action_cards.cycle_seq AND a.version = action_cards.appointment_version
    )
  );

CREATE FUNCTION crm.require_new_rescheduled_card_snapshot() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.appointment_version <= OLD.appointment_version THEN
    RAISE EXCEPTION 'Reactivating a rescheduled card requires a newer appointment version' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER require_new_rescheduled_card_snapshot BEFORE UPDATE ON crm.action_cards
  FOR EACH ROW WHEN (OLD.status = 'dismissed' AND OLD.dismiss_reason = 'rescheduled' AND NEW.status = 'pending')
  EXECUTE FUNCTION crm.require_new_rescheduled_card_snapshot();

GRANT INSERT (shop_id, customer_id, appointment_id, operation_key, rendered_body, scheduled_at)
  ON crm.sms_messages TO bv_system;
GRANT UPDATE (status, scheduled_at, provider_message_id, claimed_at, quota_reserved_at, retry_count)
  ON crm.sms_messages TO bv_system;
GRANT INSERT (shop_id, trace_id, causation_id, event_type, result_code) ON crm.action_logs TO bv_system;
GRANT SELECT (id, shop_id, trace_id, causation_id, event_type, result_code, recorded_at), DELETE ON crm.action_logs TO bv_system;
CREATE POLICY retain_recent_action_logs ON crm.action_logs AS RESTRICTIVE FOR DELETE TO bv_system
  USING (recorded_at < clock_timestamp() - interval '90 days');
