CREATE TABLE crm.shop_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL UNIQUE REFERENCES crm.shop (id),
  business_hours jsonb CHECK (business_hours IS NULL OR jsonb_typeof(business_hours) = 'object'),
  refund_policy text,
  naver_place_url text,
  instagram_url text,
  landing_url text,
  location_text text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE crm.shop_closure (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES crm.shop (id),
  kind text NOT NULL,
  weekday smallint,
  start_date date,
  end_date date,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (kind = 'weekly' AND weekday IS NOT NULL AND weekday BETWEEN 1 AND 7
      AND start_date IS NULL AND end_date IS NULL)
    OR (kind IN ('holiday', 'vacation') AND weekday IS NULL
      AND start_date IS NOT NULL AND end_date IS NOT NULL AND start_date <= end_date)
  )
);
CREATE INDEX shop_closure_by_shop ON crm.shop_closure (shop_id);

CREATE TABLE crm.menu (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES crm.shop (id),
  name text NOT NULL CHECK (btrim(name) <> ''),
  default_duration_min integer CHECK (default_duration_min > 0),
  default_prep_min integer CHECK (default_prep_min >= 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, id)
);

-- Staff hold appointments; they do not gain CRM login access.
CREATE TABLE crm.staff (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES crm.shop (id),
  name text NOT NULL CHECK (btrim(name) <> ''),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, id)
);

CREATE TABLE crm.customer (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES crm.shop (id),
  name text NOT NULL CHECK (btrim(name) <> ''),
  phone text,
  address text,
  notes text,
  birthdate date,
  active boolean NOT NULL DEFAULT true,
  deactivated_at timestamptz,
  created_source text NOT NULL CHECK (created_source IN ('manual', 'voice_task', 'onboarding')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, id),
  CHECK (active = (deactivated_at IS NULL))
);

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['shop_settings', 'shop_closure', 'menu', 'staff', 'customer'] LOOP
    EXECUTE format('ALTER TABLE crm.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE crm.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY shop_scope ON crm.%I
         USING (shop_id = nullif(current_setting(''app.shop_id'', true), '''')::uuid)
         WITH CHECK (shop_id = nullif(current_setting(''app.shop_id'', true), '''')::uuid)',
      table_name
    );
  END LOOP;
END
$$;

GRANT SELECT ON crm.shop_settings, crm.shop_closure, crm.menu, crm.staff, crm.customer TO bv_app;
GRANT INSERT (shop_id, kind, weekday, start_date, end_date, note) ON crm.shop_closure TO bv_app;
GRANT INSERT (shop_id, name, default_duration_min, default_prep_min, active) ON crm.menu TO bv_app;
GRANT INSERT (shop_id, name, active) ON crm.staff TO bv_app;
GRANT INSERT (shop_id, name, phone, address, notes, birthdate, created_source) ON crm.customer TO bv_app;
GRANT UPDATE (business_hours, refund_policy, naver_place_url, instagram_url, landing_url, location_text, updated_at)
  ON crm.shop_settings TO bv_app;
GRANT UPDATE (kind, weekday, start_date, end_date, note, updated_at) ON crm.shop_closure TO bv_app;
GRANT UPDATE (name, default_duration_min, default_prep_min, active, updated_at) ON crm.menu TO bv_app;
GRANT UPDATE (name, active, updated_at) ON crm.staff TO bv_app;
GRANT UPDATE (name, phone, address, notes, birthdate, active, deactivated_at, version, updated_at)
  ON crm.customer TO bv_app;
