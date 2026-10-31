// Builds the Stockpile Grafana boards (folder "Stockpile"):
//
//   system.json  Stockpile — System: pods, versions, traffic through the
//                gateway, resources, the database, the workers' queues and
//                syncs. Prometheus only. Production or staging.
//   store.json   Stockpile — Store: what sold, what is listed and what it is
//                worth, what is on hand, marketplace and drop-ship health.
//                Postgres (datasource stockpile-postgres, the read-only role
//                stockpile_grafana: grafana-grants.sql) and Prometheus.
//
// Edit this file, then:  node build.mjs   (writes the two JSON files beside it)
// Every column a Store query reads must be granted in ../grafana-grants.sql.
// Tables are Postgres's names: the InventoryUnit model is the table "NfaItem".
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PROM = { type: "prometheus" };
const PG = { type: "grafana-postgresql-datasource", uid: "stockpile-postgres" };

// ---------------------------------------------------------------- builders

function board({ title, uid, description, time, variables, annotations = [] }) {
  let id = 0;
  let x = 0;
  let y = 0;
  let lineH = 0;
  const panels = [];
  const place = (w, h) => {
    if (x + w > 24) {
      y += lineH;
      x = 0;
      lineH = 0;
    }
    const gp = { x, y, w, h };
    x += w;
    lineH = Math.max(lineH, h);
    return gp;
  };
  const api = {
    row(title, { collapsed = false } = {}) {
      y += lineH;
      x = 0;
      lineH = 0;
      panels.push({ type: "row", title, id: ++id, gridPos: { x: 0, y, w: 24, h: 1 }, collapsed, panels: [] });
      y += 1;
    },
    add(p, w, h) {
      panels.push({ ...p, id: ++id, gridPos: place(w, h) });
    },
    json() {
      return {
        title,
        uid,
        description,
        tags: ["stockpile", "batcave"],
        timezone: "browser",
        schemaVersion: 39,
        editable: true,
        graphTooltip: 1,
        refresh: "5m",
        time,
        links: [
          { type: "dashboards", tags: ["stockpile"], asDropdown: false, title: "Stockpile", includeVars: false, keepTime: true },
        ],
        templating: { list: variables },
        annotations: { list: annotations },
        panels,
      };
    },
  };
  return api;
}

const prom = (expr, legendFormat, extra = {}) => ({ datasource: PROM, expr, legendFormat, ...extra });
const promInstant = (expr, legendFormat, extra = {}) => prom(expr, legendFormat, { instant: true, range: false, ...extra });
const promTable = (expr) => prom(expr, "", { instant: true, range: false, format: "table" });
const sql = (rawSql, format = "table") => ({ datasource: PG, editorMode: "code", rawQuery: true, format, rawSql: rawSql.replace(/\s+/g, " ").trim() });

function withRefs(targets) {
  return targets.map((t, i) => ({ refId: String.fromCharCode(65 + i), ...t }));
}

const steps = (...s) => ({ mode: "absolute", steps: s.map(([color, value]) => ({ color, value })) });
const GREEN = steps(["green", null]);
const BAD_IF_ANY = steps(["green", null], ["red", 1]);
const WARN_IF_ANY = steps(["green", null], ["orange", 1]);
const OK_MAP = [{ type: "value", options: { 0: { text: "Failing", color: "red" }, 1: { text: "OK", color: "green" } } }];
const PAUSED_MAP = [{ type: "value", options: { 0: { text: "Running", color: "green" }, 1: { text: "Paused", color: "red" } } }];

function ds(targets) {
  return targets[0]?.datasource ?? PROM;
}

function stat(title, targets, o = {}) {
  return {
    type: "stat",
    title,
    description: o.desc,
    datasource: ds(targets),
    targets: withRefs(targets),
    options: {
      reduceOptions: { calcs: [o.calc ?? "lastNotNull"], fields: "", values: false },
      colorMode: o.colorMode ?? (o.thresholds ? "background" : "none"),
      graphMode: o.graph ? "area" : "none",
      textMode: o.textMode ?? "auto",
      justifyMode: "auto",
      orientation: o.orientation ?? "auto",
    },
    fieldConfig: {
      defaults: {
        unit: o.unit ?? "short",
        decimals: o.decimals,
        thresholds: o.thresholds ?? GREEN,
        mappings: o.mappings ?? [],
        noValue: o.noValue ?? "0",
        color: o.thresholds ? { mode: "thresholds" } : { mode: "fixed", fixedColor: "text" },
        links: o.links ?? [],
      },
      overrides: o.overrides ?? [],
    },
  };
}

function timeseries(title, targets, o = {}) {
  const bars = o.bars ?? false;
  return {
    type: "timeseries",
    title,
    description: o.desc,
    datasource: ds(targets),
    targets: withRefs(targets),
    options: {
      legend: { displayMode: o.legend ?? "list", placement: "bottom", calcs: o.legendCalcs ?? [] },
      tooltip: { mode: "multi", sort: "desc" },
    },
    fieldConfig: {
      defaults: {
        unit: o.unit ?? "short",
        decimals: o.decimals,
        min: o.min,
        max: o.max,
        thresholds: o.thresholds ?? GREEN,
        color: { mode: "palette-classic" },
        custom: {
          drawStyle: bars ? "bars" : "line",
          fillOpacity: bars ? 80 : (o.fill ?? 10),
          lineWidth: bars ? 0 : 1,
          barAlignment: 0,
          showPoints: "never",
          spanNulls: o.spanNulls ?? true,
          stacking: { mode: o.stack ? "normal" : "none", group: "A" },
          thresholdsStyle: { mode: o.thresholdLine ? "line+area" : "off" },
          axisSoftMin: o.softMin ?? 0,
        },
      },
      overrides: o.overrides ?? [],
    },
  };
}

function bargauge(title, targets, o = {}) {
  return {
    type: "bargauge",
    title,
    description: o.desc,
    datasource: ds(targets),
    targets: withRefs(targets),
    options: {
      reduceOptions: { calcs: ["lastNotNull"], fields: o.fields ?? "", values: o.values ?? false },
      orientation: "horizontal",
      displayMode: "basic",
      showUnfilled: true,
      valueMode: "color",
      namePlacement: "left",
      sizing: "auto",
      minVizHeight: 10,
      maxVizHeight: 24,
    },
    fieldConfig: {
      defaults: {
        unit: o.unit ?? "short",
        decimals: o.decimals,
        min: 0,
        thresholds: o.thresholds ?? steps(["blue", null]),
        color: { mode: "thresholds" },
        noValue: o.noValue,
        mappings: o.mappings ?? [],
      },
      overrides: o.overrides ?? [],
    },
  };
}

function table(title, targets, o = {}) {
  return {
    type: "table",
    title,
    description: o.desc,
    datasource: ds(targets),
    targets: withRefs(targets),
    options: { showHeader: true, cellHeight: "sm", footer: { show: !!o.footer, reducer: ["sum"], fields: o.footer ?? [], countRows: false }, sortBy: o.sortBy ?? [] },
    fieldConfig: {
      defaults: { custom: { align: "auto", cellOptions: { type: "auto" }, filterable: false }, thresholds: GREEN, mappings: o.mappings ?? [], noValue: o.noValue },
      overrides: o.overrides ?? [],
    },
    transformations: o.transformations ?? [],
  };
}

const unitOverride = (names, unit, decimals) => ({
  matcher: { id: "byRegexp", options: `^(${names.join("|")})$` },
  properties: [{ id: "unit", value: unit }, ...(decimals === undefined ? [] : [{ id: "decimals", value: decimals }])],
});
const hideFields = (names) => ({ id: "organize", options: { excludeByName: Object.fromEntries(names.map((n) => [n, true])) } });
const renameFields = (map) => ({ id: "organize", options: { renameByName: map } });
const colorBackground = (name, thresholds) => ({
  matcher: { id: "byName", options: name },
  properties: [
    { id: "custom.cellOptions", value: { type: "color-background", mode: "basic" } },
    { id: "thresholds", value: thresholds },
  ],
});
const mapOverride = (name, mappings) => ({ matcher: { id: "byName", options: name }, properties: [{ id: "mappings", value: mappings }, { id: "custom.cellOptions", value: { type: "color-text" } }] });
const widthOverride = (name, width) => ({ matcher: { id: "byName", options: name }, properties: [{ id: "custom.width", value: width }] });

const writeBoard = (file, json) => writeFileSync(join(dirname(fileURLToPath(import.meta.url)), file), JSON.stringify(json, null, 2) + "\n");

// ================================================================== SYSTEM

{
  // env: text is the database name, value the namespace (${env:text} / $env).
  const NS = `namespace="$env"`;
  const PODS = `${NS}, pod=~"stockpile-.+", pod!~".*-grants-.*"`;
  const ROUTES = `envoy_cluster_name=~".*/\${env}_stockpile-[a-z-]+_[0-9]+"`;
  const svc = (e) => `label_replace(${e}, "service", "$1", "envoy_cluster_name", ".*_(stockpile-[a-z-]+)_[0-9]+")`;
  const DB = `datname="\${env:text}"`;
  // Envoy can't split a route by path, and the print helper's jobs/next long
  // poll holds every request ~25 s (stockpile helper-v1.controller.ts), so
  // percentiles over everything measure the helper. FAST keeps the buckets up
  // to 10 s and makes 10 s the top: latency of the requests that finished.
  const FAST = (e) => `label_replace(${e}, "le", "+Inf", "le", "10000")`;
  const UNDER_10S = `le=~"0.5|1|5|10|25|50|100|250|500|1000|2500|5000|10000"`;

  const b = board({
    title: "Stockpile — System",
    uid: "stockpile-system",
    description: "Is Stockpile up and healthy: pods, versions, traffic through the gateway, resources, its database and the background workers. The store's own numbers are on Stockpile — Store.",
    time: { from: "now-24h", to: "now" },
    variables: [
      {
        type: "custom",
        name: "env",
        label: "Environment",
        query: "stockpile : batcave, stockpile_staging : stockpile-staging",
        current: { text: "stockpile", value: "batcave" },
        options: [],
        hide: 0,
        description: "Production (namespace batcave, database stockpile) or the shadow staging copy. The worker panels are production only: staging's workers aren't scraped.",
      },
    ],
    annotations: [
      {
        name: "Pod starts",
        datasource: PROM,
        enable: true,
        iconColor: "purple",
        expr: `max by (pod) (time() - kube_pod_created{namespace="$env", pod=~"stockpile-(api|web|worker|storefront).+"}) < 120`,
        step: "60s",
        titleFormat: "{{pod}} started",
      },
    ],
  });

  b.row("Health");
  b.add(stat("Alerts", [promInstant(`count(ALERTS{alertstate="firing", alertname=~"Stockpile.*"}) or vector(0)`)], { thresholds: steps(["green", null], ["red", 1]), desc: "Stockpile's alert rules (blookums prometheusrule.yaml) firing now. Production only." }), 3, 4);
  b.add(stat("Not ready", [promInstant(`sum(kube_pod_status_ready{${PODS}, condition="false"}) or vector(0)`)], { thresholds: BAD_IF_ANY }), 3, 4);
  b.add(stat("Restarts 24h", [promInstant(`sum(increase(kube_pod_container_status_restarts_total{${PODS}}[24h])) or vector(0)`)], { thresholds: WARN_IF_ANY, decimals: 0 }), 3, 4);
  b.add(stat("Workers", [promInstant(`min(stockpile_worker_healthy{${NS}})`)], { mappings: [{ type: "value", options: { 0: { text: "Unhealthy", color: "red" }, 1: { text: "Healthy", color: "green" } } }], thresholds: steps(["red", null], ["green", 1]), noValue: "No data", desc: "Workers healthy: every worker's /healthz verdict (stockpile_worker_healthy)." }), 3, 4);
  b.add(stat("Heartbeat", [promInstant(`max(stockpile_worker_heartbeat_age_seconds{${NS}})`)], { unit: "s", thresholds: steps(["green", null], ["orange", 120], ["red", 300]), noValue: "No data", desc: "Worker heartbeat: since the oldest worker's self-checks last all passed." }), 3, 4);
  b.add(stat("5xx (1h)", [promInstant(`sum(increase(envoy_cluster_upstream_rq_xx{${ROUTES}, envoy_response_code_class="5"}[1h])) or vector(0)`)], { thresholds: steps(["green", null], ["orange", 1], ["red", 20]), decimals: 0, desc: "Server errors through the gateway, last hour." }), 3, 4);
  b.add(stat("Requests 24h", [promInstant(`sum(increase(envoy_cluster_upstream_rq_total{${ROUTES}}[24h]))`)], { decimals: 0 }), 3, 4);
  b.add(stat("p95 (< 10 s)", [promInstant(`histogram_quantile(0.95, sum by (le) (${FAST(`rate(envoy_cluster_upstream_rq_time_bucket{${ROUTES}, ${UNDER_10S}}[1h])`)}))`)], { unit: "ms", thresholds: steps(["green", null], ["orange", 1000], ["red", 3000]), desc: "p95 latency over the last hour, gateway to Stockpile and back, of requests that finished within 10 s. The print helper's long polls (held ~25 s) would swamp it otherwise; requests held longer are on 'Held 10 s or more'." }), 3, 4);

  b.add(table("Deployments", [
    promTable(`max by (deployment) (kube_deployment_status_replicas_available{${NS}, deployment=~"stockpile-.+"})`),
    promTable(`max by (deployment) (kube_deployment_spec_replicas{${NS}, deployment=~"stockpile-.+"})`),
    promTable(`max by (deployment) (kube_deployment_status_replicas_updated{${NS}, deployment=~"stockpile-.+"})`),
  ], {
    transformations: [
      { id: "merge", options: {} },
      hideFields(["Time"]),
      renameFields({ "Value #A": "Available", "Value #B": "Wanted", "Value #C": "Up to date", deployment: "Deployment" }),
    ],
    overrides: [colorBackground("Available", steps(["red", null], ["green", 1]))],
  }), 8, 7);
  b.add(table("Firing alerts", [promTable(`max by (alertname, severity, shop, channel, vendor, family, queue) (ALERTS{alertstate="firing", alertname=~"Stockpile.*"})`)], {
    transformations: [hideFields(["Time", "Value"]), renameFields({ alertname: "Alert", severity: "Severity" })],
    overrides: [mapOverride("Severity", [{ type: "value", options: { critical: { color: "red", text: "critical" }, warning: { color: "orange", text: "warning" } } }])],
    noValue: "Nothing firing",
  }), 16, 7);

  b.row("Versions");
  b.add(table("Running images", [
    promTable(`max by (pod, container, image_spec) (kube_pod_container_info{${PODS}})`),
    promTable(`max by (pod) (time() - kube_pod_start_time{${PODS}})`),
    promTable(`max by (pod) (kube_pod_container_status_restarts_total{${PODS}})`),
  ], {
    desc: "Every Stockpile pod, the image it runs, how long it has been up and its restarts.",
    transformations: [
      { id: "merge", options: {} },
      hideFields(["Time", "Value #A"]),
      renameFields({ pod: "Pod", container: "Container", image_spec: "Image", "Value #B": "Up", "Value #C": "Restarts" }),
    ],
    overrides: [unitOverride(["Up"], "s", 0), colorBackground("Restarts", steps(["transparent", null], ["orange", 1], ["red", 5]))],
  }), 16, 8);
  b.add(table("Worker build", [promTable(`max by (app_kubernetes_io_controller, number, sha) (stockpile_build_info{${NS}})`)], {
    desc: "What each worker says it is (stockpile_build_info).",
    transformations: [hideFields(["Time", "Value"]), renameFields({ app_kubernetes_io_controller: "Worker", number: "Version", sha: "Commit" })],
    noValue: "No data (staging isn't scraped)",
  }), 8, 4);
  b.add(table("Database", [
    promTable(`max by (pod) (cnpg_pg_replication_in_recovery{namespace="databases", pod=~"postgres-[0-9]+"})`),
    promTable(`max by (pod) (cnpg_pg_replication_lag{namespace="databases", pod=~"postgres-[0-9]+"})`),
  ], {
    desc: "The shared Postgres cluster's instances: primary or replica, and each replica's lag. Grafana's Store queries read from a replica.",
    transformations: [{ id: "merge", options: {} }, hideFields(["Time"]), renameFields({ pod: "Instance", "Value #A": "Role", "Value #B": "Lag" })],
    overrides: [
      mapOverride("Role", [{ type: "value", options: { 0: { text: "primary", color: "blue" }, 1: { text: "replica", color: "text" } } }]),
      unitOverride(["Lag"], "s", 1),
    ],
  }), 8, 6);

  b.row("Traffic (through the gateway)");
  b.add(timeseries("Requests by service", [prom(`sum by (service) (${svc(`rate(envoy_cluster_upstream_rq_total{${ROUTES}}[$__rate_interval])`)})`, "{{service}}")], { unit: "reqps", desc: "Requests the Cilium gateway sent to each Stockpile service." }), 8, 8);
  b.add(timeseries("Responses by status", [prom(`sum by (envoy_response_code_class) (rate(envoy_cluster_upstream_rq_xx{${ROUTES}}[$__rate_interval]))`, "{{envoy_response_code_class}}xx")], {
    unit: "reqps",
    // Not stacked: an empty 5xx series would ride the top of the stack and
    // paint the chart red.
    overrides: [
      { matcher: { id: "byName", options: "2xx" }, properties: [{ id: "color", value: { mode: "fixed", fixedColor: "green" } }] },
      { matcher: { id: "byName", options: "3xx" }, properties: [{ id: "color", value: { mode: "fixed", fixedColor: "blue" } }] },
      { matcher: { id: "byName", options: "4xx" }, properties: [{ id: "color", value: { mode: "fixed", fixedColor: "orange" } }] },
      { matcher: { id: "byName", options: "5xx" }, properties: [{ id: "color", value: { mode: "fixed", fixedColor: "red" } }] },
    ],
  }), 8, 8);
  b.add(timeseries("Error rate by service", [
    prom(`sum by (service) (${svc(`rate(envoy_cluster_upstream_rq_xx{${ROUTES}, envoy_response_code_class="5"}[$__rate_interval])`)}) / sum by (service) (${svc(`rate(envoy_cluster_upstream_rq_total{${ROUTES}}[$__rate_interval])`)})`, "{{service}} 5xx"),
    prom(`sum by (service) (${svc(`rate(envoy_cluster_upstream_rq_xx{${ROUTES}, envoy_response_code_class="4"}[$__rate_interval])`)}) / sum by (service) (${svc(`rate(envoy_cluster_upstream_rq_total{${ROUTES}}[$__rate_interval])`)})`, "{{service}} 4xx"),
  ], { unit: "percentunit", desc: "Share of requests answered 5xx (and 4xx). A few 4xx are normal: expired sessions, bots." }), 8, 8);
  b.add(timeseries("Latency by service (p50 / p95 / p99)", [
    prom(`histogram_quantile(0.5, sum by (le, service) (${FAST(svc(`rate(envoy_cluster_upstream_rq_time_bucket{${ROUTES}, ${UNDER_10S}}[$__rate_interval])`))}))`, "{{service}} p50"),
    prom(`histogram_quantile(0.95, sum by (le, service) (${FAST(svc(`rate(envoy_cluster_upstream_rq_time_bucket{${ROUTES}, ${UNDER_10S}}[$__rate_interval])`))}))`, "{{service}} p95"),
    prom(`histogram_quantile(0.99, sum by (le, service) (${FAST(svc(`rate(envoy_cluster_upstream_rq_time_bucket{${ROUTES}, ${UNDER_10S}}[$__rate_interval])`))}))`, "{{service}} p99"),
  ], { unit: "ms", fill: 0, desc: "Of requests that finished within 10 s (the print helper's ~25 s long polls left out)." }), 12, 8);
  b.add(timeseries("Held 10 s or more", [prom(`sum by (service) (${svc(`rate(envoy_cluster_upstream_rq_time_count{${ROUTES}}[$__rate_interval])`)}) * 60 - sum by (service) (${svc(`rate(envoy_cluster_upstream_rq_time_bucket{${ROUTES}, le="10000"}[$__rate_interval])`)}) * 60`, "{{service}}")], {
    unit: "reqpm",
    desc: "Requests per minute that took 10 s or more. Each paired print helper long-polls ~2.4 a minute on the api; more than that is real slowness.",
  }), 12, 8);
  b.add(timeseries("In flight, timeouts and resets", [
    prom(`sum by (service) (${svc(`envoy_cluster_upstream_rq_active{${ROUTES}}`)})`, "{{service}} in flight"),
    prom(`sum by (service) (${svc(`rate(envoy_cluster_upstream_rq_timeout{${ROUTES}}[$__rate_interval])`)}) * 60`, "{{service}} timeouts/min"),
    prom(`sum by (service) (${svc(`rate(envoy_cluster_upstream_rq_rx_reset{${ROUTES}}[$__rate_interval])`)}) * 60`, "{{service}} resets/min"),
  ], { fill: 0, desc: "Requests open at the gateway (each print helper holds one), and upstream timeouts / connection resets per minute (a pod restarting mid-request shows here)." }), 12, 8);

  b.row("Resources");
  b.add(timeseries("CPU by pod", [prom(`sum by (pod) (rate(container_cpu_usage_seconds_total{${PODS}, container!=""}[$__rate_interval]))`, "{{pod}}")], { unit: "cores" }), 8, 8);
  b.add(timeseries("Memory by pod", [prom(`sum by (pod) (container_memory_working_set_bytes{${PODS}, container!=""})`, "{{pod}}")], { unit: "bytes" }), 8, 8);
  b.add(bargauge("Memory used of limit", [promInstant(`sum by (pod) (container_memory_working_set_bytes{${PODS}, container!=""}) / sum by (pod) (kube_pod_container_resource_limits{${PODS}, resource="memory"})`, "{{pod}}")], {
    unit: "percentunit",
    thresholds: steps(["green", null], ["orange", 0.8], ["red", 0.95]),
    desc: "Working set over the memory limit. At 100% the container is OOM-killed.",
  }), 8, 8);
  b.add(timeseries("CPU throttling", [prom(`sum by (pod) (rate(container_cpu_cfs_throttled_periods_total{${PODS}, container!=""}[$__rate_interval])) / sum by (pod) (rate(container_cpu_cfs_periods_total{${PODS}, container!=""}[$__rate_interval]))`, "{{pod}}")], { unit: "percentunit", desc: "Share of CPU periods a pod was held back by its CPU limit." }), 12, 7);
  b.add(timeseries("Network", [
    prom(`sum by (pod) (rate(container_network_receive_bytes_total{${PODS}}[$__rate_interval]))`, "{{pod}} in"),
    prom(`-sum by (pod) (rate(container_network_transmit_bytes_total{${PODS}}[$__rate_interval]))`, "{{pod}} out"),
  ], { unit: "Bps", softMin: undefined, desc: "Received above the line, sent below." }), 12, 7);

  b.row("Database");
  b.add(stat("Size", [promInstant(`max(cnpg_pg_database_size_bytes{${DB}})`)], { unit: "bytes", graph: true }), 4, 4);
  b.add(stat("Connections", [promInstant(`max by (pod) (sum by (pod) (cnpg_backends_total{${DB}}))`, "{{pod}}")], { decimals: 0, desc: "Open connections to this database on each instance." }), 5, 4);
  b.add(stat("Longest transaction", [promInstant(`max(cnpg_backends_max_tx_duration_seconds{${DB}})`)], { unit: "s", thresholds: steps(["green", null], ["orange", 60], ["red", 300]) }), 5, 4);
  b.add(stat("Cache hit (1h)", [promInstant(`sum(increase(cnpg_pg_stat_database_blks_hit{${DB}}[1h])) / (sum(increase(cnpg_pg_stat_database_blks_hit{${DB}}[1h])) + sum(increase(cnpg_pg_stat_database_blks_read{${DB}}[1h])))`)], { unit: "percentunit", decimals: 2, thresholds: steps(["red", null], ["orange", 0.9], ["green", 0.98]) }), 5, 4);
  b.add(stat("Deadlocks (24h)", [promInstant(`sum(increase(cnpg_pg_stat_database_deadlocks{${DB}}[24h])) or vector(0)`)], { thresholds: WARN_IF_ANY, decimals: 0 }), 5, 4);
  b.add(timeseries("Transactions", [
    prom(`sum(rate(cnpg_pg_stat_database_xact_commit{${DB}}[$__rate_interval]))`, "commits"),
    prom(`sum(rate(cnpg_pg_stat_database_xact_rollback{${DB}}[$__rate_interval]))`, "rollbacks"),
  ], { unit: "ops", desc: "Per second, all instances (reads on the replicas count too)." }), 8, 7);
  b.add(timeseries("Rows written", [
    prom(`sum(rate(cnpg_pg_stat_database_tup_inserted{${DB}}[$__rate_interval]))`, "inserted"),
    prom(`sum(rate(cnpg_pg_stat_database_tup_updated{${DB}}[$__rate_interval]))`, "updated"),
    prom(`sum(rate(cnpg_pg_stat_database_tup_deleted{${DB}}[$__rate_interval]))`, "deleted"),
  ], { unit: "rowsps", stack: true }), 8, 7);
  b.add(timeseries("Connections by state", [prom(`sum by (state) (cnpg_backends_total{${DB}})`, "{{state}}")], { stack: true }), 8, 7);

  b.row("Background work (production)");
  b.add(timeseries("Queue backlog", [prom(`sum by (queue) (stockpile_queue_jobs{${NS}, state=~"waiting|prioritized"})`, "{{queue}}")], { desc: "Jobs due and waiting for a worker, per queue." }), 8, 8);
  b.add(timeseries("Oldest waiting job", [prom(`max by (queue) (stockpile_queue_oldest_waiting_seconds{${NS}})`, "{{queue}}")], { unit: "s", desc: "Store queues alert at 15 min, the rest at 2 h." }), 8, 8);
  b.add(timeseries("Jobs running", [prom(`sum by (queue) (stockpile_queue_jobs{${NS}, state="active"})`, "{{queue}}")], { stack: true }), 8, 8);
  b.add(table("Queues now", [
    promTable(`sum by (queue, family) (stockpile_queue_jobs{${NS}, state=~"waiting|prioritized"})`),
    promTable(`sum by (queue, family) (stockpile_queue_jobs{${NS}, state="delayed"})`),
    promTable(`sum by (queue, family) (stockpile_queue_jobs{${NS}, state="failed"})`),
    promTable(`max by (queue, family) (time() - stockpile_queue_last_failed_timestamp_seconds{${NS}})`),
  ], {
    desc: "Failed = failed jobs kept by the queue, not a running total.",
    transformations: [{ id: "merge", options: {} }, hideFields(["Time"]), renameFields({ queue: "Queue", family: "Family", "Value #A": "Waiting", "Value #B": "Delayed", "Value #C": "Failed (kept)", "Value #D": "Last failure" })],
    overrides: [unitOverride(["Last failure"], "s", 0), colorBackground("Failed (kept)", steps(["transparent", null], ["orange", 1]))],
    sortBy: [{ displayName: "Waiting", desc: true }],
  }), 12, 8);
  b.add(table("Who runs what", [
    promTable(`max by (family, app_kubernetes_io_controller) (stockpile_worker_family_runs{${NS}}) == 1`),
    promTable(`max by (section, app_kubernetes_io_controller) (stockpile_metrics_section_ok{${NS}})`),
  ], {
    desc: "Job families per worker, and which parts of each worker's metrics read cleanly on the last scrape.",
    transformations: [{ id: "merge", options: {} }, hideFields(["Time", "Value #A"]), renameFields({ family: "Family", section: "Metrics section", app_kubernetes_io_controller: "Worker", "Value #B": "Section" })],
    overrides: [mapOverride("Section", OK_MAP)],
  }), 12, 8);
  b.add(table("Distributor syncs", [
    promTable(`max by (vendor, kind) (time() - stockpile_distributor_sync_last_success_timestamp_seconds{${NS}})`),
    promTable(`max by (vendor, kind) (stockpile_distributor_sync_last_status{${NS}})`),
    promTable(`max by (vendor, kind) (stockpile_distributor_sync_running_seconds{${NS}})`),
  ], {
    desc: "Each distributor's catalog and quantity syncs: since the last success, the latest run's outcome, and a run still going.",
    transformations: [{ id: "merge", options: {} }, hideFields(["Time"]), renameFields({ vendor: "Distributor", kind: "Sync", "Value #A": "Last success", "Value #B": "Latest run", "Value #C": "Running for" })],
    overrides: [unitOverride(["Last success", "Running for"], "s", 0), mapOverride("Latest run", OK_MAP)],
  }), 12, 8);
  b.add(table("Shop pricing pulls", [
    promTable(`max by (shop, vendor) (time() - stockpile_pricing_pull_last_attempt_timestamp_seconds{${NS}})`),
    promTable(`max by (shop, vendor) (stockpile_pricing_pull_last_status{${NS}})`),
    promTable(`max by (shop, vendor) (stockpile_pricing_pull_paused{${NS}})`),
  ], {
    desc: "Each shop's own distributor pricing pull (its dealer costs).",
    transformations: [{ id: "merge", options: {} }, hideFields(["Time"]), renameFields({ shop: "Shop", vendor: "Distributor", "Value #A": "Last try", "Value #B": "Outcome", "Value #C": "State" })],
    overrides: [unitOverride(["Last try"], "s", 0), mapOverride("Outcome", OK_MAP), mapOverride("State", PAUSED_MAP)],
  }), 12, 8);
  b.add(timeseries("Distributor stock freshness", [prom(`max by (vendor) (time() - stockpile_distributor_availability_timestamp_seconds{${NS}}) / max by (vendor) (stockpile_distributor_stale_after_seconds{${NS}})`, "{{vendor}}")], {
    unit: "percentunit",
    desc: "How far each distributor's stock counts are toward stale (100% = its offers count as stale).",
    thresholds: steps(["green", null], ["red", 1]),
    thresholdLine: true,
  }), 24, 6);

  writeBoard("system.json", b.json());
}

// =================================================================== STORE

{
  const SHOP = `(SELECT id FROM "Tenant" WHERE slug = '$shop')`;
  // Prisma keeps UTC in timestamp-without-zone columns: a local day is
  // (col AT TIME ZONE 'UTC') AT TIME ZONE tz, and "now" is NOW, not now().
  const LOCAL = (col) => `date_trunc('$bucket', (${col} AT TIME ZONE 'UTC') AT TIME ZONE '$tz')`;
  // A bar series over every $bucket of the time range (local), 0 where
  // nothing happened: with a gap Grafana draws a lone bar the width of the
  // chart. agg yields (d = LOCAL(...), metric, v); prefix is a WITH ... list.
  const filled = (prefix, agg) => `${prefix ? `${prefix},` : "WITH"}
    cal AS (SELECT generate_series(date_trunc('$bucket', $__timeFrom()::timestamptz AT TIME ZONE '$tz'), $__timeTo()::timestamptz AT TIME ZONE '$tz', ('1 ' || '$bucket')::interval) AS d),
    agg AS (${agg})
    SELECT cal.d AT TIME ZONE '$tz' AS time, m.metric, COALESCE(agg.v, 0) AS value
    FROM cal CROSS JOIN (SELECT DISTINCT metric FROM agg) m LEFT JOIN agg ON agg.d = cal.d AND agg.metric = m.metric ORDER BY 1`;
  const NOW = `(now() AT TIME ZONE 'UTC')`;
  const NFA_TYPES = `('SUPPRESSOR','SBR','SBS','AOW','MACHINE_GUN','DESTRUCTIVE_DEVICE')`;
  // A product's cost as the Sales report knows it now (stockpile
  // register/sale-cost.ts productCosts): the newest received cost above $0,
  // else the lowest distributor cost above $0.
  const productCost = (tenant, product) => `COALESCE(
    (SELECT rl."unitCost" FROM "ReceivingLine" rl JOIN "ReceivingBatch" rb ON rb.id = rl."batchId"
      WHERE rl."tenantId" = ${tenant} AND rl."productId" = ${product} AND rl."unitCost" > 0
      ORDER BY rb."receivedDate" DESC, rl."updatedAt" DESC LIMIT 1),
    (SELECT min(v.cost) FROM "TenantVendorPrice" v WHERE v."tenantId" = ${tenant} AND v."productId" = ${product} AND v.cost > 0))`;
  const classKind = (cls) => `CASE ${cls} WHEN 'HANDGUN' THEN 'Guns' WHEN 'LONG_GUN' THEN 'Guns' WHEN 'NFA' THEN 'NFA' WHEN 'AMMUNITION' THEN 'Ammo'
    WHEN 'OPTIC' THEN 'Optics' WHEN 'MAGAZINE' THEN 'Magazines' WHEN 'ACCESSORY' THEN 'Accessories' WHEN 'OTHER' THEN 'Other' END`;
  const unitKind = (u) => `CASE WHEN ${u}."itemType"::text IN ${NFA_TYPES} THEN 'NFA' WHEN ${u}.id IS NOT NULL THEN 'Guns' END`;

  // Every line sold in the time range, as Reports › Sales counts them
  // (stockpile reports/sales-report.service.ts): the register's COMPLETED
  // sales and returns by completedAt (a return's lines negative, sales
  // without their tax), and marketplace orders PAID, not cancelled, not the
  // sandbox, by orderedAt (items only: no shipping, no tax). cost NULL =
  // not known; profit counts only lines with a cost. NFA sales recorded
  // only on the NFA page (not rung up at the register) are not here.
  const SOLD = `WITH sold AS (
    SELECT s."completedAt" AS at, s.id AS ticket, s.kind = 'RETURN' AS is_return,
      CASE WHEN sl."nfaTransactionId" IS NOT NULL OR sl."nfaFee" THEN 'NFA' WHEN sl."specialOrderId" IS NOT NULL THEN 'Special orders' ELSE 'Register' END AS source,
      CASE WHEN sl."nfaTransactionId" IS NOT NULL OR sl."nfaFee" THEN 'NFA' ELSE COALESCE(${classKind("p.class::text")}, ${unitKind("u")}, 'Other') END AS kind,
      sl.description AS item,
      sg.sign * sl.quantity AS qty,
      sg.sign * (sl.total - sl.tax) AS sales,
      CASE WHEN sl."unitCost" > 0 THEN CASE WHEN s.kind = 'RETURN' AND sl.damaged THEN 0 ELSE sg.sign * sl."unitCost" * sl.quantity END END AS cost
    FROM "Sale" s
    CROSS JOIN LATERAL (SELECT CASE WHEN s.kind = 'RETURN' THEN -1 ELSE 1 END AS sign) sg
    JOIN "SaleLine" sl ON sl."saleId" = s.id
    LEFT JOIN "Product" p ON p.id = sl."productId"
    LEFT JOIN "NfaItem" u ON u.id = sl."inventoryUnitId"
    WHERE s."tenantId" = ${SHOP} AND s.status = 'COMPLETED' AND $__timeFilter(s."completedAt")
    UNION ALL
    SELECT o."orderedAt", o.id, false,
      CASE o.channel WHEN 'gunbroker' THEN 'GunBroker' ELSE initcap(o.channel) END,
      COALESCE(${unitKind("u")}, ${classKind("p.class::text")}, 'Other'),
      COALESCE(l.title, NULLIF(concat_ws(' ', u.make, u.model), ''), 'Marketplace item'),
      q.qty,
      COALESCE(l.subtotal, COALESCE(l."unitPrice", 0) * q.qty),
      CASE WHEN u.id IS NOT NULL THEN CASE WHEN u.cost > 0 THEN u.cost END ELSE ${productCost('o."tenantId"', 'l."productId"')} * q.qty END
    FROM "SalesOrder" o
    JOIN "SalesOrderLine" l ON l."orderId" = o.id
    CROSS JOIN LATERAL (SELECT COALESCE(NULLIF(l.quantity, 0), 1) AS qty) q
    LEFT JOIN "Product" p ON p.id = l."productId"
    LEFT JOIN "NfaItem" u ON u.id = l."inventoryUnitId"
    WHERE o."tenantId" = ${SHOP} AND NOT o.sandbox AND o.payment = 'PAID' AND NOT o."channelCancelled" AND o.status <> 'CANCELLED' AND $__timeFilter(o."orderedAt")
  )`;

  // Live listings on the marketplaces (production), each with what it would
  // bring if it sold now and what it cost us. ask: a fixed price, else the
  // buy-now price, else the auction's high bid or its start, whichever is
  // higher. cost: a drop-ship listing's distributor cost, a serialized
  // unit's own cost, else the product's cost (as above). NULL = not known.
  const LISTED = `WITH listed AS (
    SELECT cl.id, cl.channel, cl.title, cl.format, cl."bidCount", cl.watchers, cl."endsAt", cl."firstSeenAt", cl."highBid",
      GREATEST(COALESCE(cl.quantity, 1), 0) AS qty,
      COALESCE(CASE WHEN cl.format = 'FIXED' THEN cl.price END, cl."buyNowPrice", GREATEST(cl.price, cl."highBid")) AS ask,
      CASE WHEN cl."dropShipProductId" IS NOT NULL OR cl."dropShip" THEN 'Drop-ship'
           WHEN cl."inventoryUnitId" IS NOT NULL THEN 'Serialized (on hand)'
           WHEN cl."stockLevelId" IS NOT NULL OR cl."productId" IS NOT NULL THEN 'Shop stock (on hand)'
           ELSE 'Not linked' END AS source,
      CASE WHEN cl."dropShipProductId" IS NOT NULL OR cl."dropShip" THEN NULLIF(cl."dropShipCost", 0)
           WHEN cl."inventoryUnitId" IS NOT NULL THEN (SELECT NULLIF(u.cost, 0) FROM "NfaItem" u WHERE u.id = cl."inventoryUnitId" AND u.cost > 0)
           WHEN cl."productId" IS NOT NULL THEN ${productCost('cl."tenantId"', 'cl."productId"')} END AS unit_cost
    FROM "ChannelListing" cl
    WHERE cl."tenantId" = ${SHOP} AND cl.status = 'ACTIVE' AND NOT cl.sandbox
  )`;

  // Everything on hand at the shop: serialized units in stock or held for a
  // buyer (value = asking price), and counted stock (value = shelf price).
  const ONHAND = `WITH onhand AS (
    SELECT 'Serialized' AS what, u.ownership::text AS ownership,
      COALESCE(${unitKind("u")}, 'Guns') AS kind,
      1 AS qty, u."askingPrice" AS price, NULLIF(u.cost, 0) AS unit_cost,
      COALESCE(u."receivedDate"::timestamp, u."createdAt") AS since
    FROM "NfaItem" u
    WHERE u."tenantId" = ${SHOP} AND u.status IN ('IN_STOCK', 'RESERVED')
    UNION ALL
    SELECT 'Stock', 'SHOP', COALESCE(${classKind("p.class::text")}, 'Other'),
      sl."onHand", tp."shelfPrice", ${productCost('sl."tenantId"', 'sl."productId"')}, NULL
    FROM "StockLevel" sl
    JOIN "Product" p ON p.id = sl."productId"
    LEFT JOIN "TenantProduct" tp ON tp."tenantId" = sl."tenantId" AND tp."productId" = sl."productId"
    WHERE sl."tenantId" = ${SHOP} AND sl."onHand" > 0
  )`;

  const PSHOP = `shop="$shop"`;
  const money = { unit: "currencyUSD", decimals: 0 };

  const b = board({
    title: "Stockpile — Store",
    uid: "stockpile-store",
    description: "The shop's business: what sold and what it made, what is listed and what it would bring, what is on hand, and how the marketplace and drop-ship machinery is doing. Sales follow the time picker; 'now' panels don't. Profit is before marketplace and card fees, on the lines whose cost is known.",
    time: { from: "now-30d", to: "now" },
    variables: [
      {
        type: "query",
        name: "shop",
        label: "Shop",
        datasource: PG,
        query: `SELECT slug AS __value, name AS __text FROM "Tenant" WHERE active ORDER BY "createdAt"`,
        definition: `SELECT slug AS __value, name AS __text FROM "Tenant" WHERE active ORDER BY "createdAt"`,
        refresh: 1,
        sort: 0,
        hide: 0,
      },
      {
        type: "query",
        name: "tz",
        label: "Time zone",
        datasource: PG,
        query: `SELECT COALESCE((SELECT l."timeZone" FROM "Location" l JOIN "Tenant" t ON t.id = l."tenantId" WHERE t.slug = '$shop' AND l."timeZone" IS NOT NULL ORDER BY l."createdAt" LIMIT 1), 'America/New_York')`,
        definition: "the shop's first store's time zone",
        refresh: 1,
        hide: 2,
      },
      {
        type: "custom",
        name: "bucket",
        label: "Per",
        query: "day,week,month",
        current: { text: "day", value: "day" },
        options: [],
        hide: 0,
      },
    ],
  });

  // ------------------------------------------------------------ Sold
  b.row("Sold (time range)");
  b.add(stat("Sales", [sql(`${SOLD} SELECT COALESCE(sum(sales), 0) AS "Sales" FROM sold`)], { ...money, desc: "Register (net of returns, without tax) plus paid marketplace orders (items only)." }), 4, 4);
  b.add(stat("Profit (before fees)", [sql(`${SOLD} SELECT COALESCE(sum(sales - cost), 0) AS "Profit" FROM sold WHERE cost IS NOT NULL`)], { ...money, thresholds: steps(["red", null], ["green", 0]), colorMode: "value" }), 4, 4);
  b.add(stat("Margin", [sql(`${SOLD} SELECT sum(sales - cost) / NULLIF(sum(sales), 0) AS "Margin" FROM sold WHERE cost IS NOT NULL`)], { unit: "percentunit", decimals: 1, noValue: "—", desc: "Profit over the sales it was counted on (lines with a known cost)." }), 4, 4);
  b.add(stat("Tickets", [sql(`${SOLD} SELECT count(DISTINCT ticket) FILTER (WHERE NOT is_return) AS "Tickets" FROM sold`)], { decimals: 0, desc: "Register sales plus marketplace orders. Returns aren't counted." }), 4, 4);
  b.add(stat("Average ticket", [sql(`${SOLD} SELECT sum(sales) FILTER (WHERE NOT is_return) / NULLIF(count(DISTINCT ticket) FILTER (WHERE NOT is_return), 0) AS "Average" FROM sold`)], { unit: "currencyUSD", decimals: 2, noValue: "—" }), 4, 4);
  b.add(stat("Cost known", [sql(`${SOLD} SELECT sum(sales) FILTER (WHERE cost IS NOT NULL AND NOT is_return) / NULLIF(sum(sales) FILTER (WHERE NOT is_return), 0) AS "Cost known" FROM sold`)], { unit: "percentunit", decimals: 0, noValue: "—", thresholds: steps(["red", null], ["orange", 0.7], ["green", 0.9]), colorMode: "value", desc: "Share of sales whose cost is known — how much of the sales the profit covers." }), 4, 4);

  b.add(timeseries("Sales by where it sold", [sql(filled(SOLD, `SELECT ${LOCAL("at")} AS d, source AS metric, sum(sales) AS v FROM sold GROUP BY 1, 2`), "time_series")], { ...money, bars: true, stack: true, legend: "table", legendCalcs: ["sum"], desc: "Per $bucket in the shop's time zone." }), 12, 9);
  b.add(timeseries("Profit by where it sold", [sql(filled(SOLD, `SELECT ${LOCAL("at")} AS d, source AS metric, sum(sales - cost) AS v FROM sold WHERE cost IS NOT NULL GROUP BY 1, 2`), "time_series")], { ...money, bars: true, stack: true, legend: "table", legendCalcs: ["sum"] }), 12, 9);

  b.add(table("By kind", [sql(`${SOLD} SELECT kind AS "Kind", sum(qty) AS "Sold", sum(sales) AS "Sales", sum(sales - cost) FILTER (WHERE cost IS NOT NULL) AS "Profit",
      sum(sales - cost) FILTER (WHERE cost IS NOT NULL) / NULLIF(sum(sales) FILTER (WHERE cost IS NOT NULL), 0) AS "Margin"
    FROM sold GROUP BY 1 ORDER BY 3 DESC`)], {
    overrides: [unitOverride(["Sales", "Profit"], "currencyUSD", 0), unitOverride(["Margin"], "percentunit", 1)],
    footer: ["Sold", "Sales", "Profit"],
  }), 8, 9);
  b.add(table("Where it sold", [sql(`${SOLD} SELECT source AS "Where", count(DISTINCT ticket) FILTER (WHERE NOT is_return) AS "Tickets", sum(qty) AS "Items", sum(sales) AS "Sales",
      sum(sales - cost) FILTER (WHERE cost IS NOT NULL) AS "Profit"
    FROM sold GROUP BY 1 ORDER BY 4 DESC`)], {
    overrides: [unitOverride(["Sales", "Profit"], "currencyUSD", 0)],
    footer: ["Tickets", "Items", "Sales", "Profit"],
  }), 7, 9);
  b.add(table("Best sellers", [sql(`${SOLD} SELECT item AS "Item", sum(qty) AS "Sold", sum(sales) AS "Sales", sum(sales - cost) FILTER (WHERE cost IS NOT NULL) AS "Profit"
    FROM sold GROUP BY 1 HAVING sum(qty) > 0 ORDER BY 3 DESC LIMIT 25`)], {
    overrides: [unitOverride(["Sales", "Profit"], "currencyUSD", 0), widthOverride("Sold", 60)],
  }), 9, 9);
  b.add(table("Everything sold", [sql(`${SOLD} SELECT at AS "When", source AS "Where", kind AS "Kind", item AS "Item", qty AS "Qty", sales AS "Sales", cost AS "Cost", sales - cost AS "Profit"
    FROM sold ORDER BY at DESC LIMIT 500`)], {
    desc: "Newest first, up to 500 lines. A return's lines are negative.",
    overrides: [unitOverride(["Sales", "Cost", "Profit"], "currencyUSD", 2), { matcher: { id: "byName", options: "When" }, properties: [{ id: "unit", value: "dateTimeAsLocal" }, { id: "custom.width", value: 160 }] }, widthOverride("Qty", 50)],
  }), 24, 10);

  // ------------------------------------------------------------ Listed
  b.row("Listed on the marketplaces (now)");
  b.add(stat("Live listings", [sql(`${LISTED} SELECT count(*) AS "Listings" FROM listed`)], { decimals: 0 }), 4, 4);
  b.add(stat("Units listed", [sql(`${LISTED} SELECT COALESCE(sum(qty), 0) AS "Units" FROM listed`)], { decimals: 0 }), 4, 4);
  b.add(stat("Listed value", [sql(`${LISTED} SELECT COALESCE(sum(ask * qty), 0) AS "Value" FROM listed`)], { ...money, desc: "Every live listing at its price (an auction at its buy-now, else its high bid or start), times its quantity." }), 4, 4);
  b.add(stat("Cost of what's listed", [sql(`${LISTED} SELECT COALESCE(sum(unit_cost * qty), 0) AS "Cost" FROM listed`)], { ...money, desc: "Known costs only." }), 4, 4);
  b.add(stat("If it all sold: profit", [sql(`${LISTED} SELECT COALESCE(sum((ask - unit_cost) * qty), 0) AS "Profit" FROM listed WHERE unit_cost IS NOT NULL AND ask IS NOT NULL`)], { ...money, thresholds: steps(["red", null], ["green", 0]), colorMode: "value", desc: "Before marketplace fees and shipping, on the listings whose cost is known." }), 4, 4);
  b.add(stat("Cost known", [sql(`${LISTED} SELECT sum(ask * qty) FILTER (WHERE unit_cost IS NOT NULL) / NULLIF(sum(ask * qty), 0) AS "Known" FROM listed`)], { unit: "percentunit", decimals: 0, noValue: "—", thresholds: steps(["red", null], ["orange", 0.7], ["green", 0.9]), colorMode: "value", desc: "Share of the listed value whose cost is known." }), 4, 4);

  b.add(table("What's listed, by source", [sql(`${LISTED} SELECT CASE channel WHEN 'gunbroker' THEN 'GunBroker' ELSE initcap(channel) END AS "Channel", source AS "Source", count(*) AS "Listings", sum(qty) AS "Units",
      sum(ask * qty) AS "Value", sum(unit_cost * qty) AS "Cost", sum((ask - unit_cost) * qty) AS "Profit if sold",
      sum((ask - unit_cost) * qty) / NULLIF(sum(ask * qty) FILTER (WHERE unit_cost IS NOT NULL), 0) AS "Margin",
      round(avg(EXTRACT(EPOCH FROM ${NOW} - "firstSeenAt") / 86400)) AS "Avg days up"
    FROM listed GROUP BY 1, 2 ORDER BY 5 DESC NULLS LAST`)], {
    desc: "Serialized and shop-stock listings sell what is on hand (also counted below under On hand); drop-ship listings sell a distributor's stock. Not linked: a listing Stockpile hasn't tied to anything.",
    overrides: [unitOverride(["Value", "Cost", "Profit if sold"], "currencyUSD", 0), unitOverride(["Margin"], "percentunit", 1)],
    footer: ["Listings", "Units", "Value", "Cost", "Profit if sold"],
  }), 14, 7);
  b.add(timeseries("Stockpile's own listings", [prom(`sum by (dropship) (max without (pod, instance) (stockpile_listings_active{${PSHOP}, sandbox="false"}))`, "drop-ship {{dropship}}")], {
    desc: "Live listings Stockpile created, over time (worker metrics). drop-ship true = selling a distributor's stock.",
    stack: true,
    overrides: [
      { matcher: { id: "byName", options: "drop-ship true" }, properties: [{ id: "displayName", value: "Drop-ship" }] },
      { matcher: { id: "byName", options: "drop-ship false" }, properties: [{ id: "displayName", value: "Our stock" }] },
    ],
  }), 10, 7);

  b.add(timeseries("Listings added and ended unsold", [
    sql(filled("", `SELECT ${LOCAL('cl."firstSeenAt"')} AS d, 'Added' AS metric, count(*) AS v FROM "ChannelListing" cl
      WHERE cl."tenantId" = ${SHOP} AND NOT cl.sandbox AND $__timeFilter(cl."firstSeenAt") GROUP BY 1, 2`), "time_series"),
    sql(filled("", `SELECT ${LOCAL('cl."endedAt"')} AS d, 'Ended unsold' AS metric, count(*) AS v FROM "ChannelListing" cl
      WHERE cl."tenantId" = ${SHOP} AND NOT cl.sandbox AND cl.status = 'ENDED' AND $__timeFilter(cl."endedAt") GROUP BY 1, 2`), "time_series"),
    sql(filled("", `SELECT ${LOCAL('o."orderedAt"')} AS d, 'Sold' AS metric, sum(COALESCE(NULLIF(l.quantity, 0), 1)) AS v FROM "SalesOrder" o JOIN "SalesOrderLine" l ON l."orderId" = o.id
      WHERE o."tenantId" = ${SHOP} AND NOT o.sandbox AND o.status <> 'CANCELLED' AND NOT o."channelCancelled" AND $__timeFilter(o."orderedAt") GROUP BY 1, 2`), "time_series"),
  ], { bars: true, legend: "table", legendCalcs: ["sum"], desc: "Per $bucket: listings first seen, listings that ended without selling, and items sold on the marketplaces." }), 12, 8);
  b.add(table("Ending soonest", [sql(`${LISTED} SELECT title AS "Listing", format::text AS "Format", ask AS "Price", "highBid" AS "High bid", "bidCount" AS "Bids", watchers AS "Watching", "endsAt" AS "Ends"
    FROM listed WHERE "endsAt" > ${NOW} ORDER BY "endsAt" LIMIT 25`)], {
    overrides: [unitOverride(["Price", "High bid"], "currencyUSD", 2), { matcher: { id: "byName", options: "Ends" }, properties: [{ id: "unit", value: "dateTimeFromNow" }, { id: "custom.width", value: 110 }] }],
  }), 12, 8);
  b.add(table("Most watched", [sql(`${LISTED} SELECT title AS "Listing", ask AS "Price", unit_cost AS "Cost", watchers AS "Watching", "bidCount" AS "Bids", round(EXTRACT(EPOCH FROM ${NOW} - "firstSeenAt") / 86400) AS "Days up"
    FROM listed WHERE watchers > 0 ORDER BY watchers DESC, ask DESC LIMIT 25`)], {
    overrides: [unitOverride(["Price", "Cost"], "currencyUSD", 2)],
  }), 12, 8);
  b.add(table("Up longest without selling", [sql(`${LISTED} SELECT title AS "Listing", source AS "Source", ask AS "Price", unit_cost AS "Cost", COALESCE(watchers, 0) AS "Watching", round(EXTRACT(EPOCH FROM ${NOW} - "firstSeenAt") / 86400) AS "Days up"
    FROM listed ORDER BY "firstSeenAt" LIMIT 25`)], {
    desc: "Candidates for a price cut. Days since Stockpile first saw the listing (a relist starts over).",
    overrides: [unitOverride(["Price", "Cost"], "currencyUSD", 2), colorBackground("Days up", steps(["transparent", null], ["orange", 30], ["red", 90]))],
  }), 12, 8);

  // ------------------------------------------------------------ On hand
  b.row("On hand (now)");
  b.add(stat("Retail value on hand", [sql(`${ONHAND} SELECT COALESCE(sum(price * qty), 0) AS "Value" FROM onhand WHERE ownership = 'SHOP'`)], { ...money, desc: "Shop-owned: serialized units at their asking price plus counted stock at its shelf price. Consigned items are separate." }), 4, 4);
  b.add(stat("Cost on hand", [sql(`${ONHAND} SELECT COALESCE(sum(unit_cost * qty), 0) AS "Cost" FROM onhand WHERE ownership = 'SHOP'`)], { ...money, desc: "What the shop-owned stock cost, where known." }), 4, 4);
  b.add(stat("If it all sold: profit", [sql(`${ONHAND} SELECT COALESCE(sum((price - unit_cost) * qty), 0) AS "Profit" FROM onhand WHERE ownership = 'SHOP' AND price IS NOT NULL AND unit_cost IS NOT NULL`)], { ...money, thresholds: steps(["red", null], ["green", 0]), colorMode: "value", desc: "Shop-owned items with both a price and a cost." }), 4, 4);
  b.add(stat("Priced and costed", [sql(`${ONHAND} SELECT sum(qty) FILTER (WHERE price IS NOT NULL AND unit_cost IS NOT NULL)::float / NULLIF(sum(qty), 0) AS "Known" FROM onhand WHERE ownership = 'SHOP'`)], { unit: "percentunit", decimals: 0, noValue: "—", thresholds: steps(["red", null], ["orange", 0.7], ["green", 0.9]), colorMode: "value", desc: "Share of shop-owned units with both a price and a cost (what the profit above covers)." }), 4, 4);
  b.add(stat("Units on hand", [sql(`${ONHAND} SELECT COALESCE(sum(qty), 0) AS "Units" FROM onhand WHERE ownership = 'SHOP'`)], { decimals: 0 }), 4, 4);
  b.add(stat("Consigned on hand", [sql(`${ONHAND} SELECT COALESCE(sum(price * qty), 0) AS "Asking" FROM onhand WHERE ownership = 'CONSIGNOR'`)], { ...money, desc: "Consignors' items here, at their asking prices (the shop earns only its cut)." }), 4, 4);

  b.add(table("On hand by kind", [sql(`${ONHAND} SELECT kind AS "Kind", what AS "Tracked as", sum(qty) AS "Units", sum(price * qty) AS "Retail value", sum(unit_cost * qty) AS "Cost",
      sum((price - unit_cost) * qty) AS "Profit if sold", sum(qty) FILTER (WHERE price IS NULL) AS "No price", sum(qty) FILTER (WHERE unit_cost IS NULL) AS "No cost"
    FROM onhand WHERE ownership = 'SHOP' GROUP BY 1, 2 ORDER BY 4 DESC NULLS LAST`)], {
    overrides: [unitOverride(["Retail value", "Cost", "Profit if sold"], "currencyUSD", 0), colorBackground("No price", steps(["transparent", null], ["orange", 1])), colorBackground("No cost", steps(["transparent", null], ["orange", 1]))],
    footer: ["Units", "Retail value", "Cost", "Profit if sold", "No price", "No cost"],
  }), 14, 8);
  b.add(bargauge("Serialized units by age", [sql(`${ONHAND} SELECT CASE WHEN since > ${NOW} - interval '30 days' THEN '0–30 days' WHEN since > ${NOW} - interval '90 days' THEN '31–90 days'
      WHEN since > ${NOW} - interval '180 days' THEN '91–180 days' WHEN since > ${NOW} - interval '365 days' THEN '181–365 days' ELSE 'Over a year' END AS bucket,
      min(since) AS oldest, sum(unit_cost) AS "Cost tied up"
    FROM onhand WHERE what = 'Serialized' AND ownership = 'SHOP' GROUP BY 1 ORDER BY 2 DESC`)], {
    ...money,
    values: true,
    fields: "/^Cost tied up$/",
    desc: "Shop-owned guns and NFA items in stock, by days since received: the money sitting in each age band.",
    thresholds: steps(["green", null], ["orange", 5000], ["red", 20000]),
  }), 10, 8);

  b.add(stat("Online store: items shown", [sql(`SELECT count(*) FILTER (WHERE shown) AS "Shown" FROM "StorefrontListing" WHERE "tenantId" = ${SHOP}`)], { decimals: 0, desc: "Products on the shop's own online store." }), 6, 4);
  b.add(stat("Online store: shown and in stock", [sql(`SELECT count(*) FILTER (WHERE shown AND "inStock") AS "In stock" FROM "StorefrontListing" WHERE "tenantId" = ${SHOP}`)], { decimals: 0 }), 6, 4);
  b.add(stat("Online store: value in stock", [sql(`SELECT COALESCE(sum(price) FILTER (WHERE shown AND "inStock"), 0) AS "Value" FROM "StorefrontListing" WHERE "tenantId" = ${SHOP}`)], { ...money, desc: "One of each shown, in-stock item at its online price." }), 6, 4);
  b.add(stat("Online store: added (range)", [sql(`SELECT count(*) AS "Added" FROM "StorefrontListing" WHERE "tenantId" = ${SHOP} AND $__timeFilter("firstListedAt")`)], { decimals: 0 }), 6, 4);

  // ------------------------------------------------------------ Marketplace health
  b.row("Marketplace health (GunBroker)");
  b.add(stat("Attention", [promInstant(`sum(max without (pod, instance) (stockpile_orders{${PSHOP}, sandbox="false", status="NEEDS_ATTENTION"})) or vector(0)`)], { thresholds: BAD_IF_ANY, decimals: 0, desc: "Marketplace orders on Needs attention." }), 3, 4);
  b.add(stat("Unstarted", [promInstant(`max(max without (pod, instance) (stockpile_orders_oldest_new_age_seconds{${PSHOP}, sandbox="false"}))`)], { unit: "s", thresholds: steps(["green", null], ["orange", 3600], ["red", 86400]), desc: "Oldest unstarted order: the oldest paid NEW order nobody has started (no source chosen). Drop-ship alerts at 1 h." }), 3, 4);
  b.add(stat("Listings", [promInstant(`max(time() - max without (pod, instance) (stockpile_marketplace_listing_sync_last_attempt_timestamp_seconds{${PSHOP}, sandbox="false"}))`)], { unit: "s", thresholds: steps(["green", null], ["orange", 1800], ["red", 3600]), noValue: "No account", desc: "Since the listing sync last read the listings (alerts at 30 min): it keeps quantity listings from overselling." }), 3, 4);
  b.add(stat("Orders", [promInstant(`max(time() - max without (pod, instance) (stockpile_marketplace_orders_last_success_timestamp_seconds{${PSHOP}, sandbox="false"}))`)], { unit: "s", thresholds: steps(["green", null], ["orange", 1800], ["red", 3600]), noValue: "No account", desc: "Orders polled: since the last complete orders poll (alerts at 1 h): new sales come in this way." }), 3, 4);
  b.add(stat("Syncs", [promInstant(`min(max without (pod, instance) (stockpile_marketplace_listing_sync_last_status{${PSHOP}, sandbox="false"})) * min(max without (pod, instance) (stockpile_marketplace_orders_last_status{${PSHOP}, sandbox="false"}))`)], { mappings: OK_MAP, thresholds: steps(["red", null], ["green", 1]), noValue: "No account", desc: "The last listing sync and orders poll both succeeded." }), 3, 4);
  b.add(stat("Account", [promInstant(`max(max without (pod, instance) (stockpile_marketplace_paused{${PSHOP}, sandbox="false"}))`)], { mappings: PAUSED_MAP, thresholds: steps(["green", null], ["red", 1]), noValue: "No account", desc: "Paused after a refused login or User-Agent; the owner lifts it." }), 3, 4);
  b.add(stat("Publishing", [promInstant(`sum(max without (pod, instance) (stockpile_listing_problems{${PSHOP}, sandbox="false", problem=~"publish_failed_24h|publish_uncertain"})) or vector(0)`)], { thresholds: WARN_IF_ANY, decimals: 0, desc: "Publish problems: publishes that failed in the last 24 h, plus ones sent with no clear answer." }), 3, 4);
  b.add(stat("Needs you", [promInstant(`sum(max without (pod, instance) (stockpile_listing_problems{${PSHOP}, sandbox="false", problem="needs_person"})) or vector(0)`)], { thresholds: WARN_IF_ANY, decimals: 0, desc: "Listings needing a person — Stockpile listings on Needs attention: stock drift, or a flag only a person clears." }), 3, 4);

  b.add(timeseries("Orders by status", [prom(`sum by (status) (max without (pod, instance) (stockpile_orders{${PSHOP}, sandbox="false", status!~"COMPLETE|CANCELLED"}))`, "{{status}}")], { stack: true, desc: "Open marketplace orders: the work in progress." }), 8, 8);
  b.add(timeseries("Listing problems", [prom(`sum by (problem) (max without (pod, instance) (stockpile_listing_problems{${PSHOP}, sandbox="false"}))`, "{{problem}}")], {}), 8, 8);
  b.add(timeseries("Ended unsold (last hour) vs live", [prom(`sum(max without (pod, instance) (stockpile_listings_ended_1h{${PSHOP}, sandbox="false"})) / clamp_min(sum(max without (pod, instance) (stockpile_listings_active{${PSHOP}, sandbox="false"})), 1)`, "share ended")], {
    unit: "percentunit",
    desc: "Stockpile's own listings that ended unsold in the hour, as a share of those live. A spike = a mass ending (cost feed, stock or policy).",
  }), 8, 8);

  b.add(table("Orders this period", [sql(`SELECT CASE o.channel WHEN 'gunbroker' THEN 'GunBroker' ELSE initcap(o.channel) END AS "Channel", o.status::text AS "Status", count(*) AS "Orders",
      count(*) FILTER (WHERE o."fflRequired") AS "Need an FFL", sum(o."itemsTotal") AS "Items", sum(o."shippingTotal") AS "Shipping",
      avg(EXTRACT(EPOCH FROM o."shippedAt" - COALESCE(o."paymentReceivedAt", o."orderedAt"))) FILTER (WHERE o."shippedAt" IS NOT NULL) AS "Paid to shipped"
    FROM "SalesOrder" o WHERE o."tenantId" = ${SHOP} AND NOT o.sandbox AND $__timeFilter(o."orderedAt") GROUP BY 1, 2 ORDER BY 3 DESC`)], {
    desc: "Marketplace orders placed in the time range, by where they stand now. Paid to shipped: the average time from payment (or order) to marked shipped.",
    overrides: [unitOverride(["Items", "Shipping"], "currencyUSD", 0), unitOverride(["Paid to shipped"], "s", 0)],
    footer: ["Orders", "Need an FFL", "Items", "Shipping"],
  }), 24, 7);

  // ------------------------------------------------------------ Drop-ship
  b.row("Drop-ship");
  b.add(bargauge("Catalog funnel", [promInstant(`max by (stage) (stockpile_dropship_products{${PSHOP}})`, "{{stage}}")], { desc: "Distributor products judged, eligible to list, picked (whitelisted) and blocked." }), 6, 7);
  b.add(bargauge("Why products can't list", [promInstant(`topk(10, max by (reason) (stockpile_dropship_ineligible{${PSHOP}}))`, "{{reason}}")], { desc: "Ineligible products by reason (one with several counts under each). Up to 10 minutes old." }), 6, 7);
  b.add(timeseries("Eligibility flips (24h)", [prom(`max by (direction) (stockpile_dropship_flips_24h{${PSHOP}})`, "{{direction}}")], { desc: "Products that gained or lost eligibility in the last day. Lost > 500 alerts (a feed going bad)." }), 6, 7);
  b.add(timeseries("Median listing margin", [prom(`max(stockpile_dropship_listing_margin_cents{${PSHOP}, agg="p50"}) / 100`, "p50")], { unit: "currencyUSD", desc: "Median price − distributor cost over live drop-ship listings, before fees and shipping. Halving overnight suggests a cost-feed error." }), 6, 7);
  b.add(stat("Picked but ineligible", [promInstant(`max(stockpile_dropship_picked_ineligible{${PSHOP}}) or vector(0)`)], { thresholds: WARN_IF_ANY, decimals: 0, desc: "Whitelisted products that can't list now: curation earning nothing." }), 4, 4);
  b.add(stat("To order by hand", [promInstant(`max(stockpile_dropship_by_hand_pending{${PSHOP}}) or vector(0)`)], { thresholds: WARN_IF_ANY, decimals: 0, desc: "Guns and NFA items a person must order on the distributor's site." }), 4, 4);
  b.add(stat("Oldest by-hand order", [promInstant(`max(stockpile_dropship_oldest_by_hand_age_seconds{${PSHOP}})`)], { unit: "s", thresholds: steps(["green", null], ["orange", 7200], ["red", 86400]) }), 4, 4);
  b.add(stat("Oldest unshipped (distributor)", [promInstant(`max(stockpile_dropship_oldest_unshipped_age_seconds{${PSHOP}})`)], { unit: "s", thresholds: steps(["green", null], ["orange", 86400], ["red", 172800]), desc: "The oldest distributor order placed with no tracking yet." }), 4, 4);
  b.add(stat("Held by the order limits", [promInstant(`max(stockpile_dropship_orders_held_by_limits{${PSHOP}}) or vector(0)`)], { thresholds: BAD_IF_ANY, decimals: 0 }), 4, 4);
  b.add(stat("Distributor spend (last hour)", [promInstant(`max(stockpile_dropship_committed_spend_cents_1h{${PSHOP}}) / 100 or vector(0)`)], { unit: "currencyUSD", decimals: 0, thresholds: steps(["green", null], ["orange", 250], ["red", 500]), desc: "Cost of the last hour's live sends (the limits hold at $500)." }), 4, 4);
  b.add(table("Distributor orders this period", [sql(`SELECT d."pluginId" AS "Distributor", d.mode AS "Mode", d.status AS "Status", count(*) AS "Orders", sum(d.cost) AS "Cost"
    FROM "DistributorOrder" d WHERE d."tenantId" = ${SHOP} AND $__timeFilter(d."createdAt") GROUP BY 1, 2, 3 ORDER BY 4 DESC`)], {
    desc: "Drop-ship orders sent to (or made by hand at) a distributor in the time range.",
    overrides: [unitOverride(["Cost"], "currencyUSD", 0)],
    footer: ["Orders", "Cost"],
  }), 24, 6);

  writeBoard("store.json", b.json());
}
