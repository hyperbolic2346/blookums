-- Shadow staging's nightly refresh (stockpile#331): last night's production
-- copy, put in place of stockpile_staging's contents and scrubbed, in ONE
-- transaction (psql --single-transaction, refresh.sh restore). Either all of
-- it commits — the new copy, scrubbed — or none of it does, and staging keeps
-- yesterday's scrubbed copy. Never an unscrubbed copy, not for a moment.
--
-- Run as stockpile_staging's owner (the app's own role), never a superuser:
-- it owns the database, so it may drop and recreate its public schema and
-- create the trusted pg_trgm extension the dump asks for.
--
-- Nothing here prints a row. psql runs it with -q; the counts at the end are
-- counts.
\set ON_ERROR_STOP on
SET client_min_messages = warning;

-- 1. What staging keeps across nights: plugin settings someone saved IN
-- STAGING (their secrets sealed under staging's own key id, "v2.staging.").
-- Production's are sealed under production's key, which staging doesn't
-- have; they are stripped below.
CREATE TEMP TABLE staging_keep (
  "tenantId" text NOT NULL,
  "locationId" text,
  category text NOT NULL,
  "pluginId" text NOT NULL,
  enabled boolean NOT NULL,
  config jsonb NOT NULL
) ON COMMIT DROP;
DO $keep$
BEGIN
  IF to_regclass('public."TenantPluginConfig"') IS NOT NULL THEN
    INSERT INTO staging_keep
      SELECT "tenantId", "locationId", category, "pluginId", enabled, config::jsonb
      FROM public."TenantPluginConfig"
      WHERE config::text LIKE '%"v2.staging.%';
  END IF;
END
$keep$;

-- 2. Yesterday's copy goes; tonight's comes in.
DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;
\i /work/restore.sql
SET search_path TO public;

-- 3. The scrub. Customer emails and phone numbers are wiped or replaced
-- (Mike's decision, 2026-10-05, epic #328); licenses, units, orders, names
-- and addresses stay. A replaced email is unique and can't be delivered
-- (.invalid); a phone is cleared.
CREATE FUNCTION pg_temp.scrub_contact(j jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE
  out jsonb;
BEGIN
  IF j IS NULL THEN
    RETURN NULL;
  ELSIF jsonb_typeof(j) = 'object' THEN
    SELECT COALESCE(jsonb_object_agg(
             e.key,
             CASE
               WHEN e.key ~* '(e-?mail|phone|mobile|telephone)' AND jsonb_typeof(e.value) IN ('string', 'number')
                 THEN to_jsonb('scrubbed'::text)
               ELSE pg_temp.scrub_contact(e.value)
             END), '{}'::jsonb)
      INTO out FROM jsonb_each(j) AS e;
    RETURN out;
  ELSIF jsonb_typeof(j) = 'array' THEN
    SELECT COALESCE(jsonb_agg(pg_temp.scrub_contact(a.v) ORDER BY a.i), '[]'::jsonb)
      INTO out FROM jsonb_array_elements(j) WITH ORDINALITY AS a(v, i);
    RETURN out;
  END IF;
  RETURN j;
END
$fn$;

UPDATE public."Customer" SET
  email = CASE WHEN email IS NULL THEN NULL ELSE 'customer-' || id || '@scrubbed.invalid' END,
  phone = NULL
  WHERE email IS NOT NULL OR phone IS NOT NULL;
UPDATE public."NfaCustomer" SET
  email = CASE WHEN email IS NULL THEN NULL ELSE 'nfa-customer-' || id || '@scrubbed.invalid' END,
  phone = NULL
  WHERE email IS NOT NULL OR phone IS NOT NULL;
UPDATE public."Consignor" SET
  email = CASE WHEN email IS NULL THEN NULL ELSE 'consignor-' || id || '@scrubbed.invalid' END,
  phone = NULL
  WHERE email IS NOT NULL OR phone IS NOT NULL;
UPDATE public."SpecialOrder" SET "customerPhone" = NULL WHERE "customerPhone" IS NOT NULL;
UPDATE public."SalesOrder" SET
  "buyerEmail" = CASE WHEN "buyerEmail" IS NULL THEN NULL ELSE 'buyer-' || id || '@scrubbed.invalid' END,
  "billToEmail" = CASE WHEN "billToEmail" IS NULL THEN NULL ELSE 'buyer-' || id || '@scrubbed.invalid' END,
  "shipToPhone" = NULL,
  "billToPhone" = NULL,
  raw = pg_temp.scrub_contact(raw::jsonb);
UPDATE public."CustomerEmail" SET
  "toAddress" = 'customer-email-' || id || '@scrubbed.invalid',
  body = '(This email''s text is removed in staging.)';
-- Invitations are addressed to people; none is accepted in staging.
DELETE FROM public."TenantInvite";
-- Contact details inside stored JSON: the channel's order, labels and
-- shipments (EasyPost's to-address), distributor order requests, bound-book
-- import rows, merges and the audit log's before/after.
-- The audit log refuses updates (its append-only trigger): off for the
-- scrub, inside this transaction, and back on before it commits.
ALTER TABLE public."AuditEvent" DISABLE TRIGGER USER;
UPDATE public."AuditEvent" SET
  "before" = pg_temp.scrub_contact("before"::jsonb),
  "after" = pg_temp.scrub_contact("after"::jsonb),
  summary = regexp_replace(summary, '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}', 'scrubbed@scrubbed.invalid', 'g')
  WHERE "before" IS NOT NULL OR "after" IS NOT NULL OR summary ~ '@';
ALTER TABLE public."AuditEvent" ENABLE TRIGGER USER;
UPDATE public."SalesOrderLabel" SET
  shipment = pg_temp.scrub_contact(shipment::jsonb),
  rate = pg_temp.scrub_contact(rate::jsonb),
  "rateOptions" = pg_temp.scrub_contact("rateOptions"::jsonb);
UPDATE public."AdHocShipment" SET
  "toAddress" = pg_temp.scrub_contact("toAddress"::jsonb),
  shipment = pg_temp.scrub_contact(shipment::jsonb),
  rate = pg_temp.scrub_contact(rate::jsonb),
  quotes = pg_temp.scrub_contact(quotes::jsonb);
UPDATE public."DistributorOrder" SET request = pg_temp.scrub_contact(request::jsonb) WHERE request IS NOT NULL;
UPDATE public."AdImport" SET "rows" = pg_temp.scrub_contact("rows"::jsonb);
UPDATE public."CustomerMerge" SET moved = pg_temp.scrub_contact(moved::jsonb);
-- A 4473 buyer's ID number and the book's PIN are sealed under
-- production's key: staging can never open them. Cleared.
UPDATE public."NfaForm4473" SET "buyerIdNumberSealed" = NULL, "pinSealed" = NULL
  WHERE "buyerIdNumberSealed" IS NOT NULL OR "pinSealed" IS NOT NULL;

-- 4. Plugin secrets. Staging's own (step 1) come back; every secret sealed
-- under another key (production's: v1, or v2 under any id but "staging") is
-- removed, so those accounts read "not connected" until someone connects
-- them in staging. Nothing tries production's credentials, and nothing
-- holds them.
UPDATE public."TenantPluginConfig" t SET config = k.config, enabled = k.enabled
  FROM staging_keep k
  WHERE t."tenantId" = k."tenantId" AND t.category = k.category AND t."pluginId" = k."pluginId"
    AND t."locationId" IS NOT DISTINCT FROM k."locationId";
INSERT INTO public."TenantPluginConfig" (id, "tenantId", "locationId", category, "pluginId", enabled, config, "createdAt", "updatedAt")
  SELECT 'stg' || md5(random()::text || clock_timestamp()::text || k."tenantId" || k."pluginId"),
         k."tenantId", k."locationId", k.category, k."pluginId", k.enabled, k.config,
         now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC'
  FROM staging_keep k
  WHERE EXISTS (SELECT 1 FROM public."Tenant" s WHERE s.id = k."tenantId")
    AND (k."locationId" IS NULL OR EXISTS (SELECT 1 FROM public."Location" l WHERE l.id = k."locationId"))
    AND NOT EXISTS (
      SELECT 1 FROM public."TenantPluginConfig" t
      WHERE t."tenantId" = k."tenantId" AND t.category = k.category AND t."pluginId" = k."pluginId"
        AND t."locationId" IS NOT DISTINCT FROM k."locationId");
CREATE FUNCTION pg_temp.strip_foreign_secrets(j jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE
  out jsonb;
BEGIN
  IF j IS NULL THEN
    RETURN NULL;
  ELSIF jsonb_typeof(j) = 'object' THEN
    SELECT COALESCE(jsonb_object_agg(e.key, pg_temp.strip_foreign_secrets(e.value)), '{}'::jsonb)
      INTO out FROM jsonb_each(j) AS e
      WHERE NOT (jsonb_typeof(e.value) = 'string'
                 AND (e.value #>> '{}' LIKE 'v1.%'
                      OR (e.value #>> '{}' LIKE 'v2.%' AND e.value #>> '{}' NOT LIKE 'v2.staging.%')));
    RETURN out;
  ELSIF jsonb_typeof(j) = 'array' THEN
    SELECT COALESCE(jsonb_agg(pg_temp.strip_foreign_secrets(a.v) ORDER BY a.i), '[]'::jsonb)
      INTO out FROM jsonb_array_elements(j) WITH ORDINALITY AS a(v, i)
      WHERE NOT (jsonb_typeof(a.v) = 'string'
                 AND (a.v #>> '{}' LIKE 'v1.%' OR (a.v #>> '{}' LIKE 'v2.%' AND a.v #>> '{}' NOT LIKE 'v2.staging.%')));
    RETURN out;
  END IF;
  RETURN j;
END
$fn$;
UPDATE public."TenantPluginConfig" SET config = pg_temp.strip_foreign_secrets(config::jsonb)
  WHERE config::text ~ '"v(1|2)\.';

-- 5. No distributor catalog syncs of staging's own: the catalog arrives with
-- this copy every night. The platform's catalog and quantity schedules are
-- removed by the worker when it sees these off (and staging has no platform
-- feed credentials besides).
UPDATE public."Vendor" SET "syncEnabled" = false WHERE "tenantId" IS NULL AND "syncEnabled";

-- 6. Counts only, for the log.
SELECT 'copied and scrubbed: '
  || (SELECT count(*) FROM public."Tenant") || ' shop(s), '
  || (SELECT count(*) FROM public."Customer") || ' customer(s), '
  || (SELECT count(*) FROM public."SalesOrder") || ' sales order(s); '
  || (SELECT count(*) FROM staging_keep) || ' staging plugin setting(s) kept; '
  || (SELECT count(*) FROM public."TenantPluginConfig" WHERE config::text ~ '"v1\.' OR config::text ~ '"v2\.(?!staging\.)') || ' production secret(s) left (must be 0)';
DO $check$
BEGIN
  IF EXISTS (SELECT 1 FROM public."Customer" WHERE email IS NOT NULL AND email NOT LIKE '%@scrubbed.invalid')
     OR EXISTS (SELECT 1 FROM public."Customer" WHERE phone IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public."SalesOrder" WHERE ("buyerEmail" IS NOT NULL AND "buyerEmail" NOT LIKE '%@scrubbed.invalid') OR "shipToPhone" IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public."TenantPluginConfig" WHERE config::text ~ '"v1\.' OR config::text ~ '"v2\.(?!staging\.)')
  THEN
    RAISE EXCEPTION 'The scrub left contact details or production secrets behind; nothing is committed.';
  END IF;
END
$check$;
