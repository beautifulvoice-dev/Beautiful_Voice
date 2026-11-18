\set ON_ERROR_STOP on
\getenv app_password BV_LOCAL_APP_DB_PASSWORD

SELECT 'CREATE ROLE bv_app NOLOGIN'
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'bv_app')
\gexec
SELECT format('CREATE ROLE bv_app_local LOGIN PASSWORD %L', :'app_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'bv_app_local')
\gexec
GRANT bv_app TO bv_app_local;
