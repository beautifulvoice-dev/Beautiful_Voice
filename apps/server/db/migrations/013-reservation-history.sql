REVOKE INSERT ON crm.appointment_event FROM bv_app;

CREATE FUNCTION crm.record_appointment_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  event_type text;
  before_change jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    event_type := 'created';
  ELSIF NEW.status = 'canceled' AND OLD.status IS DISTINCT FROM NEW.status THEN
    event_type := 'cancel';
  ELSIF (NEW.period, NEW.prep_minutes, NEW.is_forced)
      IS DISTINCT FROM (OLD.period, OLD.prep_minutes, OLD.is_forced) THEN
    event_type := 'moved';
  ELSE
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    before_change := jsonb_build_object(
      'start', to_char(lower(OLD.period) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'end', to_char(upper(OLD.period) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'prepMinutes', OLD.prep_minutes, 'isForced', OLD.is_forced
    );
  END IF;

  INSERT INTO crm.appointment_event
    (shop_id, appointment_id, type, from_status, to_status, actor, source, before, after)
  VALUES (
    NEW.shop_id, NEW.id, event_type, OLD.status, NEW.status,
    coalesce(nullif(current_setting('app.event_actor', true), ''), 'system'),
    coalesce(nullif(current_setting('app.event_source', true), ''), 'system'), before_change,
    jsonb_build_object(
      'start', to_char(lower(NEW.period) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'end', to_char(upper(NEW.period) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'prepMinutes', NEW.prep_minutes, 'isForced', NEW.is_forced
    )
  );
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION crm.record_appointment_event() FROM PUBLIC;

CREATE TRIGGER appointment_record_event AFTER INSERT OR UPDATE ON crm.appointment
  FOR EACH ROW EXECUTE FUNCTION crm.record_appointment_event();

-- History remains available after an appointment is removed by maintenance.
CREATE TABLE crm.appointment_m1_event (
  shop_id uuid NOT NULL,
  appointment_id uuid NOT NULL,
  version integer NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('created', 'updated', 'status_changed')),
  before_change jsonb,
  after_change jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (shop_id, appointment_id, version)
);

ALTER TABLE crm.appointment_m1_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm.appointment_m1_event FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_history ON crm.appointment_m1_event FOR SELECT TO bv_app
  USING (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid);
CREATE POLICY supervisor_history ON crm.appointment_m1_event FOR SELECT TO bv_ops USING (true);
-- Only the migration owner holds INSERT; the trigger invokes it with definer rights.
CREATE POLICY record_history ON crm.appointment_m1_event FOR INSERT TO CURRENT_USER WITH CHECK (true);
GRANT SELECT ON crm.appointment_m1_event TO bv_app, bv_ops;

CREATE FUNCTION crm.record_appointment_m1_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  event_type text := 'created';
  before_change jsonb;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.version = NEW.version THEN RETURN NEW; END IF;
    event_type := CASE WHEN OLD.status IS DISTINCT FROM NEW.status THEN 'status_changed' ELSE 'updated' END;
    before_change := to_jsonb(OLD) - 'occupied';
  END IF;

  INSERT INTO crm.appointment_m1_event (shop_id, appointment_id, version, event_type, before_change, after_change)
  VALUES (NEW.shop_id, NEW.id, NEW.version, event_type, before_change, to_jsonb(NEW) - 'occupied');
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION crm.record_appointment_m1_event() FROM PUBLIC;

CREATE TRIGGER appointment_m1_record_event AFTER INSERT OR UPDATE ON crm.appointment_m1
  FOR EACH ROW EXECUTE FUNCTION crm.record_appointment_m1_event();
