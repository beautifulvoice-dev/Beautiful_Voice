CREATE TABLE crm.shop (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  timezone text NOT NULL DEFAULT 'Asia/Seoul',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE crm.user_membership (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL UNIQUE REFERENCES crm.shop (id),
  user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, id)
);

ALTER TABLE crm.shop ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm.shop FORCE ROW LEVEL SECURITY;
CREATE POLICY shop_scope ON crm.shop
  USING (id = nullif(current_setting('app.shop_id', true), '')::uuid)
  WITH CHECK (id = nullif(current_setting('app.shop_id', true), '')::uuid);

ALTER TABLE crm.user_membership ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm.user_membership FORCE ROW LEVEL SECURITY;
CREATE POLICY membership_scope ON crm.user_membership
  USING (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid)
  WITH CHECK (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid);

GRANT USAGE ON SCHEMA crm TO bv_app;
GRANT SELECT ON crm.shop, crm.user_membership TO bv_app;
GRANT UPDATE (name, timezone, updated_at) ON crm.shop TO bv_app;
