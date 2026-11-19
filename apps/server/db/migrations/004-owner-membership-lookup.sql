-- Before a shop is known, the authenticated owner can see only their own membership.
CREATE POLICY authenticated_owner_lookup ON crm.user_membership
  FOR SELECT TO bv_app
  USING (
    nullif(current_setting('app.shop_id', true), '') IS NULL
    AND user_id = nullif(current_setting('app.authenticated_user_id', true), '')::uuid
  );
