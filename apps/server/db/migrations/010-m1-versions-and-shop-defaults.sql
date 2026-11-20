ALTER TABLE crm.menu ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version >= 1);
ALTER TABLE crm.staff ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version >= 1);

CREATE FUNCTION crm.bump_m1_reference_version() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  NEW.version := OLD.version + 1;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION crm.bump_m1_reference_version() FROM PUBLIC;

CREATE TRIGGER menu_next_version BEFORE UPDATE ON crm.menu
  FOR EACH ROW EXECUTE FUNCTION crm.bump_m1_reference_version();
CREATE TRIGGER staff_next_version BEFORE UPDATE ON crm.staff
  FOR EACH ROW EXECUTE FUNCTION crm.bump_m1_reference_version();
CREATE TRIGGER customer_next_version BEFORE UPDATE ON crm.customer
  FOR EACH ROW EXECUTE FUNCTION crm.bump_m1_reference_version();

REVOKE UPDATE (updated_at) ON crm.menu, crm.staff, crm.customer FROM bv_app;
REVOKE UPDATE (version) ON crm.customer FROM bv_app;
REVOKE UPDATE (kind, weekday, start_date, end_date, note, updated_at) ON crm.shop_closure FROM bv_app;

CREATE FUNCTION crm.create_shop_settings() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  previous_shop_id text := current_setting('app.shop_id', true);
BEGIN
  PERFORM set_config('app.shop_id', NEW.id::text, true);
  INSERT INTO crm.shop_settings (shop_id) VALUES (NEW.id);
  PERFORM set_config('app.shop_id', coalesce(previous_shop_id, ''), true);
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION crm.create_shop_settings() FROM PUBLIC;

CREATE TRIGGER shop_create_settings AFTER INSERT ON crm.shop
  FOR EACH ROW EXECUTE FUNCTION crm.create_shop_settings();
