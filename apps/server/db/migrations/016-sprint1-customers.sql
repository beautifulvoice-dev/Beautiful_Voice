-- Review draft for the Sprint 1 shared migration, based on main 799b8dd.
-- Customer additions only. Allocate the migration number with the shared PR.
-- Preserve phone, address and notes. Phone backfill and uniqueness follow a conflict inventory.
-- sms_opt_out records an opt-out flag and does not grant permission to send.

ALTER TABLE crm.customer
  ADD COLUMN neighborhood text,
  ADD COLUMN sms_opt_out boolean NOT NULL DEFAULT false;

GRANT INSERT (neighborhood, sms_opt_out), UPDATE (neighborhood, sms_opt_out)
  ON crm.customer TO bv_app;

CREATE TABLE crm.customer_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES crm.shop (id),
  customer_id uuid NOT NULL,
  body text NOT NULL CHECK (body ~ '[^[:space:]]'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (shop_id, customer_id) REFERENCES crm.customer (shop_id, id)
);

CREATE INDEX customer_notes_by_customer
  ON crm.customer_notes (shop_id, customer_id, created_at DESC, id DESC);

ALTER TABLE crm.customer_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm.customer_notes FORCE ROW LEVEL SECURITY;

CREATE POLICY shop_scope ON crm.customer_notes
  FOR ALL TO bv_app
  USING (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid)
  WITH CHECK (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid);

GRANT SELECT ON crm.customer_notes TO bv_app;
GRANT INSERT (shop_id, customer_id, body) ON crm.customer_notes TO bv_app;
