-- The migration runner wraps this in a transaction. Only the table owner bypasses RLS here.
ALTER TABLE crm.shop NO FORCE ROW LEVEL SECURITY;
ALTER TABLE crm.shop_settings NO FORCE ROW LEVEL SECURITY;
INSERT INTO crm.shop_settings (shop_id)
SELECT id FROM crm.shop
ON CONFLICT (shop_id) DO NOTHING;
ALTER TABLE crm.shop_settings FORCE ROW LEVEL SECURITY;
ALTER TABLE crm.shop FORCE ROW LEVEL SECURITY;

GRANT DELETE ON crm.shop_closure TO bv_app;
