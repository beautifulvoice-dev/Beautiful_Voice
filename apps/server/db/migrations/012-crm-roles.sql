-- PostgreSQL roles are shared by databases on the same instance.
DO $$
DECLARE
  group_role text;
BEGIN
  FOREACH group_role IN ARRAY ARRAY['bv_ai_executor', 'bv_ops', 'bv_provision', 'bv_system']
  LOOP
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = group_role) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN', group_role);
    END IF;
  END LOOP;
END
$$;

GRANT USAGE ON SCHEMA crm TO bv_ai_executor, bv_ops, bv_provision, bv_system;

-- AI gets only its assigned shop and no settings writes.
DO $$
DECLARE
  relation text;
BEGIN
  FOREACH relation IN ARRAY ARRAY['shop_settings', 'shop_closure', 'menu', 'staff', 'customer', 'appointment_m1']
  LOOP
    EXECUTE format(
      'CREATE POLICY ai_shop_read ON crm.%I FOR SELECT TO bv_ai_executor
       USING (shop_id = nullif(current_setting(''app.shop_id'', true), '''')::uuid)', relation
    );
  END LOOP;
END
$$;
GRANT SELECT ON crm.shop_settings, crm.shop_closure, crm.menu, crm.staff, crm.customer, crm.appointment_m1 TO bv_ai_executor;

-- Supervisors can inspect CRM data across shops.
DO $$
DECLARE
  relation text;
BEGIN
  FOREACH relation IN ARRAY ARRAY[
    'shop', 'shop_settings', 'shop_closure', 'menu', 'staff', 'customer',
    'appointment_m1', 'appointment', 'appointment_event'
  ]
  LOOP
    EXECUTE format('CREATE POLICY supervisor_read ON crm.%I FOR SELECT TO bv_ops USING (true)', relation);
    EXECUTE format('GRANT SELECT ON crm.%I TO bv_ops', relation);
  END LOOP;
END
$$;

CREATE POLICY provision_shop ON crm.shop TO bv_provision
  USING (true) WITH CHECK (true);
CREATE POLICY provision_owner ON crm.user_membership TO bv_provision
  USING (true) WITH CHECK (true);
GRANT SELECT (id, name), INSERT (name) ON crm.shop TO bv_provision;
GRANT SELECT (shop_id, user_id, kakao_user_id), INSERT (shop_id, user_id, kakao_user_id)
  ON crm.user_membership TO bv_provision;
