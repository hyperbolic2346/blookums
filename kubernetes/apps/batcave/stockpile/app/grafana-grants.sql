-- What Grafana's read-only role may read (datasource stockpile-postgres;
-- role: databases/cloudnative-pg, managed role stockpile_grafana). Run as
-- the stockpile database's owner by the CronJob stockpile-rehearsal-grants,
-- beside the rehearsal's grants. Idempotent.
--
-- Column by column, only what the Stockpile — Store board reads
-- (dashboards/build.mjs): amounts, counts, states, timestamps, titles and
-- the shop's slug. Never a buyer's or customer's name, username, email,
-- phone or address, an FFL's details, a serial number, a 4473 or anything
-- else from the NFA and bound-book tables. A column a migration dropped or
-- renamed is skipped with a WARNING (the board's query then errors and says
-- which); a table-level REVOKE first clears what this list no longer names.
-- One transaction: Grafana never sees the gap. Table names are Postgres's
-- (the InventoryUnit model is "NfaItem").
\set ON_ERROR_STOP on
GRANT CONNECT ON DATABASE stockpile TO stockpile_grafana;
GRANT USAGE ON SCHEMA public TO stockpile_grafana;
DO $grants$
DECLARE
  wanted jsonb := $json$ {
    "Tenant":            ["id", "slug", "name", "active", "createdAt"],
    "Location":          ["id", "tenantId", "timeZone", "createdAt"],
    "Product":           ["id", "class"],
    "TenantProduct":     ["tenantId", "productId", "shelfPrice"],
    "ReceivingBatch":    ["id", "receivedDate"],
    "ReceivingLine":     ["tenantId", "batchId", "productId", "unitCost", "updatedAt"],
    "TenantVendorPrice": ["tenantId", "productId", "cost"],
    "NfaItem":           ["id", "tenantId", "itemType", "make", "model", "status", "ownership", "cost", "askingPrice", "receivedDate", "createdAt"],
    "StockLevel":        ["tenantId", "productId", "onHand"],
    "ChannelListing":    ["id", "tenantId", "channel", "sandbox", "title", "format", "price", "buyNowPrice", "highBid", "bidCount", "watchers", "quantity", "endsAt", "status",
                          "productId", "inventoryUnitId", "stockLevelId", "dropShip", "dropShipProductId", "dropShipCost", "firstSeenAt", "endedAt"],
    "SalesOrder":        ["id", "tenantId", "channel", "sandbox", "status", "payment", "paymentReceivedAt", "channelCancelled", "fflRequired", "itemsTotal", "shippingTotal",
                          "orderedAt", "shippedAt"],
    "SalesOrderLine":    ["orderId", "productId", "inventoryUnitId", "title", "quantity", "unitPrice", "subtotal"],
    "Sale":              ["id", "tenantId", "status", "kind", "completedAt"],
    "SaleLine":          ["saleId", "productId", "inventoryUnitId", "description", "quantity", "total", "tax", "unitCost", "damaged", "specialOrderId", "nfaTransactionId", "nfaFee"],
    "DistributorOrder":  ["tenantId", "pluginId", "mode", "status", "cost", "createdAt"],
    "StorefrontListing": ["tenantId", "shown", "inStock", "price", "firstListedAt"]
  } $json$;
  t text;
  have text;
  missing text;
BEGIN
  EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM stockpile_grafana';
  FOR t IN SELECT jsonb_object_keys(wanted) LOOP
    IF to_regclass(format('public.%I', t)) IS NULL THEN
      RAISE WARNING 'stockpile_grafana: no table %', t;
      CONTINUE;
    END IF;
    SELECT string_agg(format('%I', c), ', ') INTO have
      FROM jsonb_array_elements_text(wanted -> t) c
      WHERE EXISTS (SELECT FROM information_schema.columns WHERE table_schema = 'public' AND table_name = t AND column_name = c);
    SELECT string_agg(c, ', ') INTO missing
      FROM jsonb_array_elements_text(wanted -> t) c
      WHERE NOT EXISTS (SELECT FROM information_schema.columns WHERE table_schema = 'public' AND table_name = t AND column_name = c);
    IF missing IS NOT NULL THEN
      RAISE WARNING 'stockpile_grafana: % has no column(s) %', t, missing;
    END IF;
    IF have IS NOT NULL THEN
      EXECUTE format('GRANT SELECT (%s) ON public.%I TO stockpile_grafana', have, t);
    END IF;
  END LOOP;
END
$grants$;
SELECT 'stockpile_grafana may read columns of ' || count(DISTINCT table_name) || ' tables'
  FROM information_schema.column_privileges
  WHERE grantee = 'stockpile_grafana' AND table_schema = 'public';
