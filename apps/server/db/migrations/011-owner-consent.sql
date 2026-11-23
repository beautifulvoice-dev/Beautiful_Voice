CREATE TABLE crm.owner_consent (
  user_id uuid NOT NULL,
  version text NOT NULL,
  consent_text text NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, version)
);

ALTER TABLE crm.owner_consent ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm.owner_consent FORCE ROW LEVEL SECURITY;
CREATE POLICY own_consent ON crm.owner_consent TO bv_app
  USING (user_id = nullif(current_setting('app.authenticated_user_id', true), '')::uuid)
  WITH CHECK (user_id = nullif(current_setting('app.authenticated_user_id', true), '')::uuid);

GRANT SELECT (user_id, version), INSERT (user_id, version, consent_text)
  ON crm.owner_consent TO bv_app;
