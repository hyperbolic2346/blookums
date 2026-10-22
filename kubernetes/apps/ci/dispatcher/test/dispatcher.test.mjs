// Unit tests for the build dispatcher (../app/dispatcher.mjs).
//
//   node --test kubernetes/apps/ci/dispatcher/test/*.test.mjs
//
// Node's own test runner, no dependencies. The real module is imported with
// DISPATCHER_NO_MAIN=1; a fake Kubernetes API and a fake GitHub status API
// (one local HTTP server) stand in for the cluster, so schedule() runs
// unchanged against them.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------- fakes

const fake = { jobs: new Map(), configmaps: new Map(), statuses: [], calls: [], rv: 1 };

function reset() {
  fake.jobs.clear();
  fake.configmaps.clear();
  fake.statuses.length = 0;
  fake.calls.length = 0;
}

function selects(obj, selector) {
  if (!selector) return true;
  const labels = obj.metadata.labels || {};
  return selector.split(",").every((term) => {
    const [k, v] = term.split("=");
    return labels[k] === v;
  });
}

function send(res, code, body) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(body === undefined ? "" : JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const url = new URL(req.url, "http://x");
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
    fake.calls.push({ method: req.method, path: url.pathname, query: url.search, body });
    let m;
    if ((m = /^\/repos\/[^/]+\/([^/]+)\/statuses\/([0-9a-f]+)$/.exec(url.pathname))) {
      fake.statuses.push({ repo: m[1], sha: m[2], ...body });
      return send(res, 201, {});
    }
    if ((m = /^\/apis\/batch\/v1\/namespaces\/ci\/jobs(?:\/([^/]+))?$/.exec(url.pathname))) {
      const name = m[1];
      if (!name && req.method === "GET") {
        const items = [...fake.jobs.values()].filter((j) => selects(j, url.searchParams.get("labelSelector")));
        return send(res, 200, { items: structuredClone(items) });
      }
      if (!name && req.method === "POST") {
        if (fake.jobs.has(body.metadata.name)) return send(res, 409, { reason: "AlreadyExists" });
        body.metadata.resourceVersion = String(fake.rv++);
        body.status = {};
        fake.jobs.set(body.metadata.name, body);
        return send(res, 201, body);
      }
      const job = fake.jobs.get(name);
      if (!job) return send(res, 404, { reason: "NotFound" });
      if (req.method === "GET") return send(res, 200, structuredClone(job));
      if (req.method === "PATCH") {
        const want = body.metadata && body.metadata.resourceVersion;
        if (want && want !== job.metadata.resourceVersion) return send(res, 409, { reason: "Conflict" });
        if (body.metadata && body.metadata.annotations) Object.assign(job.metadata.annotations, body.metadata.annotations);
        if (body.spec) Object.assign(job.spec, body.spec);
        job.metadata.resourceVersion = String(fake.rv++);
        return send(res, 200, structuredClone(job));
      }
      if (req.method === "DELETE") {
        const want = body && body.preconditions && body.preconditions.resourceVersion;
        if (want && want !== job.metadata.resourceVersion) return send(res, 409, { reason: "Conflict" });
        if (url.searchParams.get("propagationPolicy") === "Foreground") {
          job.metadata.deletionTimestamp = new Date().toISOString();
          job.metadata.resourceVersion = String(fake.rv++);
        } else fake.jobs.delete(name);
        return send(res, 200, {});
      }
    }
    if ((m = /^\/api\/v1\/namespaces\/ci\/configmaps(?:\/([^/]+))?$/.exec(url.pathname))) {
      const name = m[1];
      if (!name && req.method === "GET") {
        const items = [...fake.configmaps.values()].filter((c) => selects(c, url.searchParams.get("labelSelector")));
        return send(res, 200, { items: structuredClone(items) });
      }
      if (!name && req.method === "POST") {
        if (fake.configmaps.has(body.metadata.name)) return send(res, 409, {});
        body.metadata.resourceVersion = String(fake.rv++);
        fake.configmaps.set(body.metadata.name, body);
        return send(res, 201, body);
      }
      const cm = fake.configmaps.get(name);
      if (!cm) return send(res, 404, {});
      if (req.method === "GET") return send(res, 200, structuredClone(cm));
      if (req.method === "PUT") {
        if (body.metadata.resourceVersion !== cm.metadata.resourceVersion) return send(res, 409, {});
        body.metadata.resourceVersion = String(fake.rv++);
        fake.configmaps.set(name, body);
        return send(res, 200, body);
      }
      if (req.method === "DELETE") {
        fake.configmaps.delete(name);
        return send(res, 200, {});
      }
    }
    if (/^\/api\/v1\/namespaces\/ci\/pods$/.test(url.pathname)) return send(res, 200, { items: [] });
    send(res, 404, { reason: "no fake for " + req.method + " " + url.pathname });
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
server.unref();
const API = "http://127.0.0.1:" + server.address().port;

// ---------------------------------------------------------------- module

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dispatcher-test-"));
const dirs = { secrets: path.join(tmp, "secrets"), sa: path.join(tmp, "sa"), logs: path.join(tmp, "logs"), work: path.join(tmp, "work") };
for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
fs.mkdirSync(path.join(dirs.secrets, "github"));
fs.writeFileSync(path.join(dirs.secrets, "github", "status_token"), "test-token\n");
fs.mkdirSync(path.join(dirs.secrets, "hooks"));
fs.writeFileSync(path.join(dirs.secrets, "hooks", "stockpile"), "hook-secret\n");
fs.writeFileSync(path.join(dirs.sa, "token"), "sa-token\n");
fs.writeFileSync(path.join(tmp, "config.json"), JSON.stringify({
  owner: "hyperbolic2346",
  statusContext: "cluster/build",
  releaseStatusContext: "cluster/release",
  githubApi: API,
  tagMode: "release",
  buildNumberFloor: 1000,
  repos: {
    stockpile: { buildArgs: {}, images: [{ name: "api", dockerfile: "apps/api/Dockerfile", repository: "ghcr.io/x/stockpile-api" }] },
    sutler: { buildArgs: {}, images: [{ name: "api", dockerfile: "apps/api/Dockerfile", repository: "ghcr.io/x/sutler-api" }] },
  },
}));
Object.assign(process.env, {
  DISPATCHER_NO_MAIN: "1",
  CONFIG_PATH: path.join(tmp, "config.json"),
  SECRETS_DIR: dirs.secrets,
  SA_DIR: dirs.sa,
  LOG_DIR: dirs.logs,
  WORK_DIR: dirs.work,
  POD_NAMESPACE: "ci",
  K8S_URL: API,
});
// Keep the module's JSON log lines out of the test report.
const write = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => (String(chunk).startsWith('{"ts":') ? true : write(chunk, ...rest));

const d = await import("../app/dispatcher.mjs");

// ---------------------------------------------------------------- helpers

const L = "dispatcher.ci/";
let seq = 0;

function sha(n) {
  return String(n).repeat(40).slice(0, 40).replace(/[^0-9a-f]/g, "a");
}

// A Job as jobFor() makes it, with the state the test wants.
function job({ repo = "stockpile", kind = "main", sha: s, number, pr, tag, state = "queued", dropped }) {
  const lane = kind === "pr" ? "untrusted" : "trusted";
  const name = kind === "main" ? repo + "-main-" + s.slice(0, 7) + "-b" + number
    : kind === "tag" ? repo + "-tag-" + tag.replace(/\./g, "-") + "-" + s.slice(0, 7)
      : repo + "-pr-" + pr + "-" + s.slice(0, 7);
  const j = {
    metadata: {
      name,
      resourceVersion: String(fake.rv++),
      labels: {
        "app.kubernetes.io/managed-by": "ci-dispatcher",
        [L + "repo"]: repo, [L + "lane"]: lane, [L + "kind"]: kind,
        ...(pr ? { [L + "pr"]: String(pr) } : {}),
      },
      annotations: {
        [L + "sha"]: s,
        [L + "ref"]: kind === "main" ? "refs/heads/main" : kind === "tag" ? "refs/tags/" + tag : "refs/pull/" + pr + "/head",
        [L + "seq"]: String(++seq).padStart(15, "0") + "-000000",
        [L + "tags"]: "",
        [L + "version"]: kind === "main" ? "main-" + s.slice(0, 7) + "-b" + number : kind === "tag" ? tag.slice(1) : "pr-" + pr,
        ...(number != null ? { [L + "build-number"]: String(number) } : {}),
        ...(dropped ? { [L + "dropped"]: dropped } : {}),
      },
      creationTimestamp: new Date().toISOString(),
    },
    spec: { suspend: state === "queued" },
    status: state === "running" ? { active: 1, startTime: new Date().toISOString() }
      : state === "success" ? { startTime: new Date().toISOString(), completionTime: new Date().toISOString(),
        conditions: [{ type: "Complete", status: "True" }] }
        : {},
  };
  if (state === "success") j.metadata.annotations[L + "reported"] = "true";
  return j;
}

function put(...jobs) {
  for (const j of jobs) fake.jobs.set(j.metadata.name, j);
  return jobs;
}

const names = (drops) => drops.map((x) => x.job.metadata.name).sort();
const deletes = () => fake.calls.filter((c) => c.method === "DELETE" && c.path.includes("/jobs/"));
const released = () => fake.calls.filter((c) => c.method === "PATCH" && c.body.spec && c.body.spec.suspend === false)
  .map((c) => c.path.split("/").pop());

beforeEach(reset);

// ---------------------------------------------------------------- main coalescing

test("six queued main builds: only the newest is kept", () => {
  const jobs = [1, 2, 3, 4, 5, 6].map((i) => job({ sha: sha(i), number: 1000 + i }));
  const drops = d.planDrops(jobs);
  assert.deepEqual(names(drops), names(jobs.slice(0, 5).map((j) => ({ job: j }))));
  for (const x of drops) {
    assert.equal(x.stop, false);
    assert.equal(x.post, true);
    assert.equal(x.description, "Skipped: superseded by " + sha(6).slice(0, 7) + " (build 1006) before it started");
  }
});

test("a running main build is never dropped; queued ones below the newest are", () => {
  const running = job({ sha: sha(1), number: 1001, state: "running" });
  const b2 = job({ sha: sha(2), number: 1002 });
  const b3 = job({ sha: sha(3), number: 1003 });
  assert.deepEqual(names(d.planDrops([running, b2, b3])), [b2.metadata.name]);
  // A running build older than everything is never touched either.
  assert.deepEqual(d.planDrops([running]), []);
  // Nor a running one below a queued newer one.
  const late = job({ sha: sha(4), number: 1000, state: "running" });
  assert.ok(!names(d.planDrops([late, b3])).includes(late.metadata.name));
});

test("tag builds are never coalesced", () => {
  const t1 = job({ kind: "tag", sha: sha(1), tag: "v1.2.0" });
  const t2 = job({ kind: "tag", sha: sha(2), tag: "v1.3.0" });
  const m = job({ sha: sha(3), number: 1010 });
  assert.deepEqual(d.planDrops([t1, t2, m]), []);
});

test("repositories are coalesced separately", () => {
  const a = job({ repo: "stockpile", sha: sha(1), number: 1001 });
  const b = job({ repo: "sutler", sha: sha(2), number: 1002 });
  assert.deepEqual(d.planDrops([a, b]), []);
});

test("no status when another build of the same commit will still report it", () => {
  const old = job({ sha: sha(1), number: 1001 });
  const newer = job({ sha: sha(2), number: 1002 });
  const pr = job({ kind: "pr", sha: sha(1), pr: 9, state: "running" });
  const [x] = d.planDrops([old, newer, pr]);
  assert.equal(x.job, old);
  assert.equal(x.post, false);
  // A finished one has reported already; the skip is the latest word.
  const done = job({ kind: "pr", sha: sha(1), pr: 10, state: "success" });
  assert.equal(d.planDrops([old, newer, done])[0].post, true);
});

test("schedule: skips the older queued main builds, keeps lane order, posts honest statuses", async () => {
  const [b1, b2] = put(job({ sha: sha(1), number: 1001 }), job({ sha: sha(2), number: 1002 }));
  const [tag] = put(job({ kind: "tag", sha: sha(9), tag: "v2.0.0" }));
  const later = put(...[3, 4, 5, 6].map((i) => job({ sha: sha(i), number: 1000 + i })));
  const b6 = later[3];

  await d.schedule();

  // b1..b5 deleted, each guarded by its resourceVersion.
  const gone = deletes();
  assert.equal(gone.length, 5);
  for (const c of gone) {
    assert.match(c.query, /propagationPolicy=Background/);
    assert.ok(c.body.preconditions.resourceVersion);
  }
  assert.deepEqual([...fake.jobs.keys()].sort(), [tag.metadata.name, b6.metadata.name].sort());
  // The trusted lane keeps its order: the tag (queued before b6) starts first.
  assert.deepEqual(released(), [tag.metadata.name]);
  assert.equal(fake.jobs.get(b6.metadata.name).spec.suspend, true);

  const skipped = fake.statuses.filter((s) => s.state === "error");
  assert.deepEqual(skipped.map((s) => s.sha).sort(), [b1, b2, ...later.slice(0, 3)].map((j) => j.metadata.annotations[L + "sha"]).sort());
  for (const s of skipped) {
    assert.equal(s.context, "cluster/build");
    assert.match(s.description, /^Skipped: superseded by 6666666 \(build 1006\)/);
  }
  assert.ok(fake.statuses.some((s) => s.state === "pending" && s.description === "Running" && s.context === "cluster/release"));

  // Each skipped build has a log page that says why.
  const text = fs.readFileSync(path.join(dirs.logs, b1.metadata.name + ".log"), "utf8");
  assert.match(text, /^result:\s+skipped$/m);
  assert.match(text, /^status:\s+Skipped: superseded by 6666666/m);

  // Once the tag finishes, b6 runs: one at a time.
  const t = fake.jobs.get(tag.metadata.name);
  t.status = { startTime: new Date().toISOString(), completionTime: new Date().toISOString(), conditions: [{ type: "Complete", status: "True" }] };
  fake.calls.length = 0;
  await d.schedule();
  assert.deepEqual(released(), [b6.metadata.name]);
});

test("schedule: a running main build blocks the lane and is not touched", async () => {
  const [running, b2, b3] = put(
    job({ sha: sha(1), number: 1001, state: "running" }),
    job({ sha: sha(2), number: 1002 }),
    job({ sha: sha(3), number: 1003 }));
  await d.schedule();
  assert.deepEqual(deletes().map((c) => c.path.split("/").pop()), [b2.metadata.name]);
  assert.ok(fake.jobs.has(running.metadata.name));
  assert.ok(fake.jobs.has(b3.metadata.name));
  assert.deepEqual(released(), []);
});

test("schedule: a build that changed under the drop is not started that round", async () => {
  const [b1, b2] = put(job({ sha: sha(1), number: 1001 }), job({ sha: sha(2), number: 1002 }));
  // Something else touches b1 between the list and the drop.
  const orig = fake.jobs.get(b1.metadata.name);
  const realHandler = server.listeners("request")[0];
  server.removeAllListeners("request");
  server.on("request", (req, res) => {
    if (req.method === "PATCH" && req.url.endsWith("/" + b1.metadata.name)) orig.metadata.resourceVersion = String(fake.rv++);
    realHandler(req, res);
  });
  try {
    await d.schedule();
  } finally {
    server.removeAllListeners("request");
    server.on("request", realHandler);
  }
  // b1 is held, neither dropped nor started; b2, the newest, starts.
  assert.ok(fake.jobs.has(b1.metadata.name));
  assert.equal(fake.jobs.get(b1.metadata.name).spec.suspend, true);
  assert.deepEqual(released(), [b2.metadata.name]);
  assert.equal(fake.statuses.filter((s) => s.state === "error").length, 0);
  // Next round the drop goes through.
  await d.schedule();
  assert.ok(!fake.jobs.has(b1.metadata.name));
  assert.equal(fake.statuses.filter((s) => s.state === "error").length, 1);
});

test("schedule: a drop interrupted after its annotation is finished next round", async () => {
  const [b1] = put(job({ sha: sha(1), number: 1001, dropped: "Skipped: superseded by 2222222 (build 1002) before it started" }));
  const [b2] = put(job({ sha: sha(2), number: 1002, state: "running" }));
  await d.schedule();
  assert.ok(!fake.jobs.has(b1.metadata.name));
  assert.ok(fake.jobs.has(b2.metadata.name));
  assert.equal(fake.statuses[0].description, "Skipped: superseded by 2222222 (build 1002) before it started");
});

// ---------------------------------------------------------------- closed pull requests

function stateConfigMap(perRepo) {
  const data = {};
  for (const [repo, s] of Object.entries(perRepo)) {
    data[repo + ".json"] = JSON.stringify({ nextBuild: 1000, main: null, tags: {}, pulls: {}, initialized: true, ...s });
  }
  fake.configmaps.set("dispatcher-state", { metadata: { name: "dispatcher-state", resourceVersion: String(fake.rv++) }, data });
}

test("pullEvent: closed and reopened pull requests only", () => {
  assert.deepEqual(d.pullEvent("pull_request", { action: "closed", number: 5, pull_request: { number: 5, merged: true } }),
    { action: "closed", pr: "5", merged: true });
  assert.deepEqual(d.pullEvent("pull_request", { action: "closed", number: 6, pull_request: { number: 6, merged: false } }),
    { action: "closed", pr: "6", merged: false });
  assert.deepEqual(d.pullEvent("pull_request", { action: "reopened", number: 6, pull_request: { number: 6 } }),
    { action: "reopened", pr: "6", merged: false });
  assert.equal(d.pullEvent("pull_request", { action: "synchronize", number: 5, pull_request: { number: 5 } }), null);
  assert.equal(d.pullEvent("push", { action: "closed", number: 5 }), null);
  assert.equal(d.pullEvent("pull_request", { action: "closed", pull_request: { number: "5; rm" } }), null);
  assert.equal(d.pullEvent("pull_request", { action: "closed", pull_request: { number: -1 } }), null);
});

test("applyPullEvent: closing records it, reopening forgets it and rebuilds the head, a week later it is gone", () => {
  const now = new Date("2026-10-22T03:00:00Z");
  const s = { pulls: { 5: sha(5), 6: sha(6) } };
  d.applyPullEvent(s, { action: "closed", pr: "5", merged: true }, now);
  d.applyPullEvent(s, { action: "closed", pr: "6", merged: false }, now);
  assert.deepEqual(s.closedPulls, { 5: { how: "merged", at: now.toISOString() }, 6: { how: "closed", at: now.toISOString() } });
  d.applyPullEvent(s, { action: "reopened", pr: "6", merged: false }, now);
  assert.deepEqual(Object.keys(s.closedPulls), ["5"]);
  assert.deepEqual(Object.keys(s.pulls), ["5"]);
  d.applyPullEvent(s, { action: "closed", pr: "7", merged: false }, new Date(now.getTime() + 8 * 86400_000));
  assert.deepEqual(Object.keys(s.closedPulls), ["7"]);
});

test("pullRequestBuilds: a new head of a closed pull request is recorded, not built", () => {
  const s = { pulls: { 5: sha(1), 6: sha(2) }, closedPulls: { 5: { how: "merged", at: new Date().toISOString() } } };
  const builds = d.pullRequestBuilds("stockpile", s, { 5: sha(3), 6: sha(4), 7: sha(5) });
  assert.deepEqual(builds.map((b) => b.pr), ["6", "7"]);
  assert.deepEqual(s.pulls, { 5: sha(3), 6: sha(4), 7: sha(5) });
});

test("planDrops: a closed pull request's queued build is skipped and its running one stopped; nothing else", () => {
  const queued = job({ kind: "pr", sha: sha(1), pr: 5 });
  const running = job({ kind: "pr", sha: sha(2), pr: 6, state: "running" });
  const other = job({ kind: "pr", sha: sha(3), pr: 7 });
  const main = job({ sha: sha(4), number: 1001, state: "running" });
  const tag = job({ kind: "tag", sha: sha(5), tag: "v1.0.0" });
  const done = job({ kind: "pr", sha: sha(6), pr: 5, state: "success" });
  const closed = { stockpile: { 5: { how: "merged" }, 6: { how: "closed" } } };
  const drops = d.planDrops([queued, running, other, main, tag, done], closed);
  assert.deepEqual(names(drops), [queued.metadata.name, running.metadata.name].sort());
  const by = Object.fromEntries(drops.map((x) => [x.job.metadata.name, x]));
  assert.equal(by[queued.metadata.name].stop, false);
  assert.equal(by[queued.metadata.name].description, "Skipped: pull request #5 was merged before this build started");
  assert.equal(by[running.metadata.name].stop, true);
  assert.equal(by[running.metadata.name].description, "Stopped: pull request #6 was closed");
  // Another repository's pull request of the same number is not touched.
  assert.deepEqual(d.planDrops([job({ repo: "sutler", kind: "pr", sha: sha(7), pr: 5 })], closed), []);
});

test("schedule: closed pull request builds are dropped; the stopped one holds the PR lane until its pod is gone", async () => {
  stateConfigMap({ stockpile: { closedPulls: { 5: { how: "merged", at: new Date().toISOString() }, 6: { how: "closed", at: new Date().toISOString() } } } });
  const [running, queued, next] = put(
    job({ kind: "pr", sha: sha(1), pr: 5, state: "running" }),
    job({ kind: "pr", sha: sha(2), pr: 6 }),
    job({ kind: "pr", sha: sha(3), pr: 7 }));
  const [main] = put(job({ sha: sha(4), number: 1001 }));

  await d.schedule();

  const del = Object.fromEntries(deletes().map((c) => [c.path.split("/").pop(), c]));
  assert.equal(Object.keys(del).length, 2);
  assert.match(del[running.metadata.name].query, /propagationPolicy=Foreground/);
  assert.match(del[queued.metadata.name].query, /propagationPolicy=Background/);
  assert.ok(fake.jobs.get(running.metadata.name).metadata.deletionTimestamp);
  assert.ok(!fake.jobs.has(queued.metadata.name));
  // The main build runs in its own lane; PR 7 waits for the stopped pod.
  assert.deepEqual(released(), [main.metadata.name]);
  const st = Object.fromEntries(fake.statuses.filter((s) => s.state === "error").map((s) => [s.sha, s.description]));
  assert.deepEqual(st, {
    [sha(1)]: "Stopped: pull request #5 was merged",
    [sha(2)]: "Skipped: pull request #6 was closed before this build started",
  });
  assert.match(fs.readFileSync(path.join(dirs.logs, running.metadata.name + ".log"), "utf8"), /^result:\s+stopped$/m);

  // Still terminating: nothing new, and no second delete or status.
  fake.calls.length = 0;
  fake.statuses.length = 0;
  await d.schedule();
  assert.deepEqual(released(), []);
  assert.deepEqual(deletes(), []);
  assert.deepEqual(fake.statuses, []);

  // The pod is gone: PR 7 starts.
  fake.jobs.delete(running.metadata.name);
  await d.schedule();
  assert.deepEqual(released(), [next.metadata.name]);
});

test("webhook: a signed pull_request closed event is recorded in the state", async () => {
  const crypto = await import("node:crypto");
  const hooks = http.createServer(d.hookHandler);
  await new Promise((r) => hooks.listen(0, "127.0.0.1", r));
  const url = "http://127.0.0.1:" + hooks.address().port + "/hooks/github/stockpile";
  try {
    const body = JSON.stringify({ action: "closed", number: 12, pull_request: { number: 12, merged: true },
      repository: { full_name: "hyperbolic2346/stockpile" } });
    const sig = "sha256=" + crypto.createHmac("sha256", "hook-secret").update(body).digest("hex");
    const res = await fetch(url, { method: "POST", body, headers: { "X-GitHub-Event": "pull_request", "X-Hub-Signature-256": sig } });
    assert.equal(res.status, 202);
    // Recorded on the state chain; the kick and the sync after it (a no-op
    // here: no deploy key) run within about a second.
    await new Promise((r) => setTimeout(r, 1500));
    const s = JSON.parse(fake.configmaps.get("dispatcher-state").data["stockpile.json"]);
    assert.equal(s.closedPulls["12"].how, "merged");

    // A bad signature records nothing.
    const forged = body.replace('"number":12', '"number":13');
    const bad = await fetch(url, { method: "POST", body: forged, headers: { "X-GitHub-Event": "pull_request", "X-Hub-Signature-256": sig } });
    assert.equal(bad.status, 401);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(JSON.parse(fake.configmaps.get("dispatcher-state").data["stockpile.json"]).closedPulls["13"], undefined);
  } finally {
    hooks.close();
  }
});

// ---------------------------------------------------------------- superseded pull request heads

test("planDrops: a queued build of an older pull request head is skipped for the newest head", () => {
  const a = job({ kind: "pr", sha: sha(1), pr: 8 });
  const b = job({ kind: "pr", sha: sha(2), pr: 8 });
  const c = job({ kind: "pr", sha: sha(3), pr: 8 });
  const drops = d.planDrops([a, b, c]);
  assert.deepEqual(names(drops), [a.metadata.name, b.metadata.name].sort());
  for (const x of drops) {
    assert.equal(x.stop, false);
    assert.equal(x.description, "Skipped: superseded by 3333333 before it started");
  }
});

test("planDrops: a running build of an older head finishes; other pull requests are separate", () => {
  const running = job({ kind: "pr", sha: sha(1), pr: 8, state: "running" });
  const newer = job({ kind: "pr", sha: sha(2), pr: 8 });
  const other = job({ kind: "pr", sha: sha(3), pr: 9 });
  assert.deepEqual(d.planDrops([running, newer, other]), []);
});

test("planDrops: a closed pull request says closed, not superseded", () => {
  const a = job({ kind: "pr", sha: sha(1), pr: 8 });
  const b = job({ kind: "pr", sha: sha(2), pr: 8 });
  const drops = d.planDrops([a, b], { stockpile: { 8: { how: "closed" } } });
  assert.deepEqual(drops.map((x) => x.description), [
    "Skipped: pull request #8 was closed before this build started",
    "Skipped: pull request #8 was closed before this build started",
  ]);
});

test("schedule: the superseded head is dropped and the newest head starts", async () => {
  const [a, b] = put(job({ kind: "pr", sha: sha(1), pr: 8 }), job({ kind: "pr", sha: sha(2), pr: 8 }));
  await d.schedule();
  assert.ok(!fake.jobs.has(a.metadata.name));
  assert.deepEqual(released(), [b.metadata.name]);
  const err = fake.statuses.filter((s) => s.state === "error");
  assert.deepEqual(err.map((s) => [s.sha, s.description]), [[sha(1), "Skipped: superseded by 2222222 before it started"]]);
});
