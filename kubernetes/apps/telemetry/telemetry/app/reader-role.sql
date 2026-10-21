-- The dashboard's login: read-only, the telemetry database only. Run as the superuser by the
-- 02-reader-role init container on every start, so the role's password always matches
-- READER_PASSWORD in the telemetry-generated Secret. SELECT on the tables is granted by the
-- server's own migrate step (READER_ROLE), which owns them.
\set ON_ERROR_STOP on
\getenv reader_pass READER_PASSWORD
SELECT 'CREATE ROLE telemetry_reader' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'telemetry_reader')
\gexec
ALTER ROLE telemetry_reader WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 5 PASSWORD :'reader_pass';
ALTER ROLE telemetry_reader SET default_transaction_read_only = on;
ALTER ROLE telemetry_reader SET statement_timeout = '30s';
-- Only the owner and the reader may connect to this database (the superuser always can).
REVOKE ALL ON DATABASE telemetry FROM PUBLIC;
GRANT CONNECT ON DATABASE telemetry TO telemetry_reader;
