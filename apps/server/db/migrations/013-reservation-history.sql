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
