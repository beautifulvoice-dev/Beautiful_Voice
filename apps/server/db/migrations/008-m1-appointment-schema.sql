-- Keep the 006 booking table intact until the legacy data and callers are migrated.
CREATE TABLE crm.appointment_m1 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES crm.shop (id),
  customer_id uuid NOT NULL,
  menu_id uuid,
  staff_id uuid NOT NULL,
  start_at timestamptz NOT NULL CHECK (isfinite(start_at)),
  duration_min integer NOT NULL CHECK (duration_min > 0),
  prep_min integer NOT NULL DEFAULT 0 CHECK (prep_min >= 0),
  memo text,
  status text NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'completed', 'cancelled', 'no_show', 'voided')),
  occupied tstzrange NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, id),
  CONSTRAINT appointment_m1_customer_fk
    FOREIGN KEY (shop_id, customer_id) REFERENCES crm.customer (shop_id, id),
  CONSTRAINT appointment_m1_menu_fk
    FOREIGN KEY (shop_id, menu_id) REFERENCES crm.menu (shop_id, id),
  CONSTRAINT appointment_m1_staff_fk
    FOREIGN KEY (shop_id, staff_id) REFERENCES crm.staff (shop_id, id),
  CONSTRAINT appointment_m1_occupied_valid CHECK (
    NOT isempty(occupied) AND NOT lower_inf(occupied) AND NOT upper_inf(occupied)
    AND isfinite(lower(occupied)) AND isfinite(upper(occupied))
  ),
  CONSTRAINT appointment_m1_staff_overlap
    EXCLUDE USING gist (shop_id WITH =, staff_id WITH =, occupied WITH &&)
    WHERE (status NOT IN ('cancelled', 'voided'))
);

CREATE INDEX appointment_m1_by_shop_start ON crm.appointment_m1 (shop_id, start_at, id);

CREATE FUNCTION crm.set_appointment_m1_derived_fields() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  -- Durations are elapsed minutes; only the management start is stored as a time.
  NEW.occupied := tstzrange(
    NEW.start_at - make_interval(mins => NEW.prep_min),
    NEW.start_at + make_interval(mins => NEW.duration_min),
    '[)'
  );
  IF TG_OP = 'UPDATE' THEN
    NEW.version := OLD.version + 1;
    NEW.updated_at := clock_timestamp();
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER appointment_m1_derive
  BEFORE INSERT OR UPDATE ON crm.appointment_m1
  FOR EACH ROW EXECUTE FUNCTION crm.set_appointment_m1_derived_fields();

REVOKE ALL ON FUNCTION crm.set_appointment_m1_derived_fields() FROM PUBLIC;
ALTER TABLE crm.appointment_m1 ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm.appointment_m1 FORCE ROW LEVEL SECURITY;
CREATE POLICY shop_scope ON crm.appointment_m1
  USING (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid)
  WITH CHECK (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid);

GRANT SELECT ON crm.appointment_m1 TO bv_app;
GRANT INSERT (shop_id, customer_id, menu_id, staff_id, start_at, duration_min, prep_min, memo, status)
  ON crm.appointment_m1 TO bv_app;
GRANT UPDATE (customer_id, menu_id, staff_id, start_at, duration_min, prep_min, memo, status)
  ON crm.appointment_m1 TO bv_app;
