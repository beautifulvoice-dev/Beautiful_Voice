ALTER TABLE crm.user_membership
  ADD COLUMN kakao_user_id text UNIQUE CHECK (kakao_user_id ~ '^[1-9][0-9]{0,18}$');

CREATE POLICY kakao_owner_lookup ON crm.user_membership
  FOR SELECT TO bv_app
  USING (
    nullif(current_setting('app.shop_id', true), '') IS NULL
    AND kakao_user_id = nullif(current_setting('app.authenticated_kakao_id', true), '')
  );
