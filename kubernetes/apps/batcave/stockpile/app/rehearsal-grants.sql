-- What the migration rehearsal's role may read (ci/dispatcher,
-- podtemplate-rehearsal.yaml; role: databases/cloudnative-pg, managed role
-- stockpile_rehearsal). Run as the stockpile database's owner, the role the
-- app and its migrations use, by the CronJob stockpile-rehearsal-grants.
-- Idempotent. SELECT only, inside this database only; tables and sequences
-- the owner creates later (each migration) are covered by the default
-- privileges, and the next run grants anything missed anyway.
\set ON_ERROR_STOP on
GRANT CONNECT ON DATABASE stockpile TO stockpile_rehearsal;
GRANT USAGE ON SCHEMA public TO stockpile_rehearsal;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO stockpile_rehearsal;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO stockpile_rehearsal;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO stockpile_rehearsal;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON SEQUENCES TO stockpile_rehearsal;
SELECT 'stockpile_rehearsal may read ' || count(*) || ' of ' ||
  (SELECT count(*) FROM pg_tables WHERE schemaname = 'public') || ' tables'
  FROM pg_tables
  WHERE schemaname = 'public'
    AND has_table_privilege('stockpile_rehearsal', format('%I.%I', schemaname, tablename), 'SELECT');
