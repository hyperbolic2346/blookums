// Build dispatcher for the ci namespace.
//
// Watches the application repositories listed in config.json and runs one
// Kubernetes Job per build from the PodTemplates `build-trusted` (main
// branch and v* tags) and `build-untrusted` (pull requests).
//
//   - Discovery: a blobless git mirror per repository, fetched over SSH with
//     that repository's read-only deploy key. A GitHub webhook only asks for
//     an early fetch; builds are always derived from the fetched refs, and a
//     timed fetch runs every pollSeconds in case a webhook never arrives.
//   - Webhooks: POST /hooks/github/<repo>. The X-Hub-Signature-256 HMAC is
//     checked against that repository's secret before the body is parsed,
//     and the body must name the same repository. Anything else is dropped.
//   - Queue: Jobs are created suspended and released one at a time per
//     repository and lane, in creation order. Main-branch builds take their
//     build number from a counter in the ConfigMap dispatcher-state.
//   - Feedback: a commit status (config.statusContext) on every build, with
//     a link to the build log served on the log port.
//
// No dependencies beyond Node and the git/ssh binaries in the image.
//
// Note for editors: this file is applied through Flux with variable
// substitution disabled for its ConfigMap; avoid dollar-brace sequences
// anyway so that the file stays safe if that ever changes.

import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";

// ---------------------------------------------------------------- settings

const env = process.env;
const CONFIG_PATH = env.CONFIG_PATH || "/config/config.json";
const SECRETS_DIR = env.SECRETS_DIR || "/secrets";
const WORK_DIR = env.WORK_DIR || "/work";
const LOG_DIR = env.LOG_DIR || "/data/logs";
const HOOK_PORT = Number(env.HOOK_PORT || 8080);
const LOG_PORT = Number(env.LOG_PORT || 8081);
const LOG_BASE_URL = (env.LOG_BASE_URL || "").replace(/\/+$/, "");
const SA_DIR = env.SA_DIR || "/var/run/secrets/kubernetes.io/serviceaccount";
const K8S_URL = env.K8S_URL ||
  "https://" + env.KUBERNETES_SERVICE_HOST + ":" + env.KUBERNETES_SERVICE_PORT;

const MANAGED_BY = "ci-dispatcher";
const LABEL = "dispatcher.ci/";
const STATE_CM = "dispatcher-state";
const MAX_HOOK_BYTES = 5 * 1024 * 1024;
const NAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
const NS = env.POD_NAMESPACE || readText(path.join(SA_DIR, "namespace"));
const OWNER = cfg.owner;
const REPOS = cfg.repos;
const PUSH_SECRET = cfg.pushSecretName || "ci-registry-push";

// ---------------------------------------------------------------- helpers

function log(level, msg, fields) {
  const line = { ts: new Date().toISOString(), level, msg, ...(fields || {}) };
  (level === "error" ? process.stderr : process.stdout).write(JSON.stringify(line) + "\n");
}

function readText(p) {
  try {
    return fs.readFileSync(p, "utf8").trim();
  } catch {
    return null;
  }
}

function sh(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 64 << 20, timeout: 180_000, ...opts }, (err, stdout, stderr) => {
      if (err) {
        err.message += "\n" + String(stderr).slice(-2000);
        reject(err);
      } else resolve(String(stdout));
    });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function fmtDuration(ms) {
  if (!(ms >= 0)) return "?";
  const s = Math.round(ms / 1000);
  return s >= 60 ? Math.floor(s / 60) + "m" + String(s % 60).padStart(2, "0") + "s" : s + "s";
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// One promise chain per key: work queued under the same key runs in order.
const chains = new Map();
function serialize(key, fn) {
  const prev = chains.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  chains.set(key, next.catch(() => {}));
  return next;
}

// ---------------------------------------------------------------- kubernetes

async function k8s(method, p, body, contentType) {
  const token = readText(path.join(SA_DIR, "token"));
  const res = await fetch(K8S_URL + p, {
    method,
    headers: {
      Authorization: "Bearer " + token,
      Accept: "application/json",
      ...(body ? { "Content-Type": contentType || "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(method + " " + p + " -> " + res.status + " " + text.slice(0, 300));
    err.status = res.status;
    throw err;
  }
  return text ? JSON.parse(text) : null;
}

async function k8sText(p) {
  const token = readText(path.join(SA_DIR, "token"));
  const res = await fetch(K8S_URL + p, { headers: { Authorization: "Bearer " + token } });
  if (!res.ok) return null;
  return res.text();
}

const nsPath = (kind) => {
  const core = ["configmaps", "pods", "podtemplates"].includes(kind);
  return (core ? "/api/v1" : "/apis/batch/v1") + "/namespaces/" + NS + "/" + kind;
};

// ---------------------------------------------------------------- state

// { <repo>: { nextBuild, main, tags: {name: sha}, pulls: {n: sha} } }
let state = {};
let stateVersion = null;

async function loadState() {
  try {
    const cm = await k8s("GET", nsPath("configmaps") + "/" + STATE_CM);
    stateVersion = cm.metadata.resourceVersion;
    state = {};
    for (const [k, v] of Object.entries(cm.data || {})) {
      if (k.endsWith(".json")) state[k.slice(0, -5)] = JSON.parse(v);
    }
  } catch (err) {
    if (err.status !== 404) throw err;
    state = {};
    stateVersion = null;
  }
}

async function saveState() {
  const data = {};
  for (const [k, v] of Object.entries(state)) data[k + ".json"] = JSON.stringify(v);
  const body = {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name: STATE_CM,
      labels: { "app.kubernetes.io/managed-by": MANAGED_BY },
      ...(stateVersion ? { resourceVersion: stateVersion } : {}),
    },
    data,
  };
  const res = stateVersion
    ? await k8s("PUT", nsPath("configmaps") + "/" + STATE_CM, body)
    : await k8s("POST", nsPath("configmaps"), body);
  stateVersion = res.metadata.resourceVersion;
}

function repoState(repo) {
  if (!state[repo]) state[repo] = { nextBuild: 0, main: null, tags: {}, pulls: {}, initialized: false };
  const s = state[repo];
  const floor = Number(cfg.buildNumberFloor || 1);
  if (!(s.nextBuild >= floor)) s.nextBuild = floor;
  return s;
}

// ---------------------------------------------------------------- git

function deployKey(repo) {
  return path.join(SECRETS_DIR, "deploy-keys", repo);
}

function knownHosts() {
  return path.join(SECRETS_DIR, "deploy-keys", "known_hosts");
}

function cloneUrl(repo) {
  return (cfg.cloneUrl || "git@github.com:{owner}/{repo}.git").replace("{owner}", OWNER).replace("{repo}", repo);
}

function git(repo, args) {
  const sshCmd = "ssh -i " + deployKey(repo) + " -o IdentitiesOnly=yes -o BatchMode=yes" +
    " -o UserKnownHostsFile=" + knownHosts() + " -o StrictHostKeyChecking=yes";
  return sh("git", ["-C", path.join(WORK_DIR, repo + ".git"), ...args], {
    env: { ...env, HOME: WORK_DIR, GIT_SSH_COMMAND: sshCmd, GIT_TERMINAL_PROMPT: "0" },
  });
}

async function fetchRefs(repo) {
  const dir = path.join(WORK_DIR, repo + ".git");
  if (!fs.existsSync(path.join(dir, "HEAD"))) {
    await fsp.mkdir(dir, { recursive: true });
    await git(repo, ["init", "-q", "--bare"]);
    await git(repo, ["config", "remote.origin.url", cloneUrl(repo)]);
    await git(repo, ["config", "remote.origin.promisor", "true"]);
    await git(repo, ["config", "remote.origin.partialclonefilter", "blob:none"]);
    await git(repo, ["config", "core.repositoryformatversion", "1"]);
    await git(repo, ["config", "extensions.partialClone", "origin"]);
  }
  await git(repo, [
    "fetch", "-q", "--prune", "--no-tags", "--filter=blob:none", "origin",
    "+refs/heads/main:refs/heads/main",
    "+refs/tags/v*:refs/tags/v*",
    "+refs/pull/*/head:refs/pull/*/head",
  ]);
  const out = await git(repo, [
    "for-each-ref", "--format=%(refname) %(objectname) %(*objectname)",
    "refs/heads/main", "refs/tags", "refs/pull",
  ]);
  const refs = { main: null, tags: {}, pulls: {} };
  for (const line of out.split("\n")) {
    const [ref, obj, peeled] = line.trim().split(" ");
    if (!ref) continue;
    const sha = peeled || obj;
    let m;
    if (ref === "refs/heads/main") refs.main = sha;
    else if ((m = /^refs\/tags\/(v\d+\.\d+\.\d+)$/.exec(ref))) refs.tags[m[1]] = sha;
    else if ((m = /^refs\/pull\/(\d+)\/head$/.exec(ref))) refs.pulls[m[1]] = sha;
  }
  return refs;
}

// First-parent commits after `from` up to `to`, oldest first.
async function mainCommits(repo, from, to) {
  if (from) {
    try {
      await git(repo, ["cat-file", "-e", from + "^{commit}"]);
      const out = await git(repo, ["rev-list", "--first-parent", "--reverse", from + ".." + to]);
      const list = out.split("\n").map((s) => s.trim()).filter(Boolean);
      const max = Number(cfg.maxMainBacklog || 20);
      if (list.length > max) {
        log("warn", "main moved by more commits than maxMainBacklog; building the newest only", { repo, count: list.length, max });
        return list.slice(-max);
      }
      return list;
    } catch (err) {
      log("warn", "previous main commit not found; building the current head only", { repo, from, err: err.message.split("\n")[0] });
    }
  }
  return [to];
}

// ---------------------------------------------------------------- discovery

const syncTimers = new Map();

function requestSync(repo, why) {
  if (syncTimers.has(repo)) return;
  syncTimers.set(repo, setTimeout(() => {
    syncTimers.delete(repo);
    serialize("state", () => syncRepo(repo, why)).catch((err) =>
      log("error", "sync failed", { repo, err: err.message.slice(0, 1500) }));
  }, 1000));
}

async function syncRepo(repo, why) {
  if (!fs.existsSync(deployKey(repo)) || !fs.existsSync(knownHosts())) {
    log("warn", "no deploy key for repository; skipping", { repo });
    return;
  }
  const refs = await fetchRefs(repo);
  await loadState();
  const s = repoState(repo);
  const builds = [];

  if (!s.initialized) {
    // First sight of this repository: record what exists so that old tags
    // and pull requests are not rebuilt, and build the current main head.
    s.tags = { ...refs.tags };
    s.pulls = { ...refs.pulls };
    s.initialized = true;
  }

  if (refs.main && refs.main !== s.main) {
    for (const sha of await mainCommits(repo, s.main, refs.main)) {
      builds.push({ repo, kind: "main", sha, ref: "refs/heads/main", number: s.nextBuild++ });
    }
    s.main = refs.main;
  }
  for (const [tag, sha] of Object.entries(refs.tags)) {
    if (s.tags[tag] !== sha) builds.push({ repo, kind: "tag", sha, ref: "refs/tags/" + tag, tag });
    s.tags[tag] = sha;
  }
  for (const [pr, sha] of Object.entries(refs.pulls)) {
    if (s.pulls[pr] !== sha) builds.push({ repo, kind: "pr", sha, ref: "refs/pull/" + pr + "/head", pr });
    s.pulls[pr] = sha;
  }

  // Jobs first (deterministic names make a repeat harmless), then state.
  for (const b of builds) await enqueue(b);
  await saveState();
  log("info", "synced", { repo, why, queued: builds.length, main: refs.main });
  if (builds.length) kick();
}

// ---------------------------------------------------------------- jobs

function sha7(sha) {
  return sha.slice(0, 7);
}

function laneOf(b) {
  return b.kind === "pr" ? "untrusted" : "trusted";
}

function jobName(b) {
  if (b.kind === "main") return b.repo + "-main-" + sha7(b.sha) + "-b" + b.number;
  if (b.kind === "tag") return b.repo + "-tag-" + b.tag.replace(/[^a-z0-9]+/gi, "-").toLowerCase() + "-" + sha7(b.sha);
  return b.repo + "-pr-" + b.pr + "-" + sha7(b.sha);
}

// Image version as seen by the app (Sutler's VERSION build arg) and tags to push.
function versionAndTags(b) {
  const test = (cfg.tagMode || "test") !== "release";
  const pre = test ? cfg.testTagPrefix || "cluster-" : "";
  if (b.kind === "main") {
    const primary = "main-" + sha7(b.sha) + "-b" + b.number;
    const tags = test ? [pre + primary] : [primary, "main-" + sha7(b.sha), "latest"];
    return { version: primary, tags };
  }
  if (b.kind === "tag") {
    const v = b.tag.slice(1);
    const minor = v.split(".").slice(0, 2).join(".");
    return { version: v, tags: test ? [pre + v] : [v, minor] };
  }
  return { version: "pr-" + b.pr, tags: [] };
}

// Build args for one build, from the repository's config.json "buildArgs"
// map of NAME to value kind. The kinds mirror what the GitHub Actions builds
// passed, so the apps show the same build identity:
//   sha7     first 7 characters of the commit
//   number   main: the build number (the N of main-<sha>-b<N>); tag and pull
//            request builds have none and get the same value as ref
//   date     when the build was queued, UTC to the second (also the created label)
//   ref      "main", the tag name (v1.2.3), or pr-<n>
//   version  the image version from versionAndTags (Sutler's VERSION)
// The result is word-split and glob-expanded by the build script, so every
// name and value must match a strict pattern; anything else throws, which
// fails the build at queue time instead of passing it through.
const BUILD_ARG_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const BUILD_ARG_VALUE_RE = /^[A-Za-z0-9._:+-]+$/;

function buildArgsFor(b, conf, version, created) {
  // The single-arg setting this map replaced; refuse it rather than drop it.
  if (conf.versionBuildArg) throw new Error("versionBuildArg is no longer read; use buildArgs");
  const ref = b.kind === "main" ? "main" : b.kind === "tag" ? b.tag : "pr-" + b.pr;
  const kinds = {
    sha7: () => sha7(b.sha),
    number: () => (b.number != null ? String(b.number) : ref),
    date: () => created,
    ref: () => ref,
    version: () => version,
  };
  return Object.entries(conf.buildArgs || {}).map(([name, kind]) => {
    if (!BUILD_ARG_NAME_RE.test(name)) throw new Error("build arg name not allowed: " + JSON.stringify(name));
    if (!Object.hasOwn(kinds, kind)) throw new Error("build arg " + name + " has unknown kind " + JSON.stringify(kind));
    const value = kinds[kind]();
    if (typeof value !== "string" || !BUILD_ARG_VALUE_RE.test(value)) throw new Error("build arg " + name + " value not allowed: " + JSON.stringify(value));
    return name + "=" + value;
  }).join(" ");
}

function containersOf(spec) {
  return [...(spec.initContainers || []), ...(spec.containers || [])];
}

// The push credential may appear only as the volume mounted into the `push`
// container of the trusted template. Refuse to create anything else.
function assertCredentialScope(spec, lane) {
  const pushVolumes = (spec.volumes || [])
    .filter((v) => v.secret && v.secret.secretName === PUSH_SECRET)
    .map((v) => v.name);
  const refsSecret = (c) =>
    JSON.stringify([c.env || [], c.envFrom || []]).includes('"' + PUSH_SECRET + '"');
  if (lane !== "trusted") {
    if (JSON.stringify(spec).includes(PUSH_SECRET)) {
      throw new Error("untrusted template references the push credential");
    }
    return;
  }
  for (const c of containersOf(spec)) {
    const mountsPush = (c.volumeMounts || []).some((m) => pushVolumes.includes(m.name));
    if (c.name !== "push" && (mountsPush || refsSecret(c))) {
      throw new Error("container " + c.name + " would receive the push credential");
    }
  }
  if (spec.shareProcessNamespace) throw new Error("shareProcessNamespace is not allowed");
}

async function jobFor(b) {
  const lane = laneOf(b);
  const conf = REPOS[b.repo];
  const tmpl = await k8s("GET", nsPath("podtemplates") + "/build-" + lane);
  const podMeta = tmpl.template.metadata || {};
  const spec = structuredClone(tmpl.template.spec);
  assertCredentialScope(spec, lane);

  const { version, tags } = versionAndTags(b);
  const created = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const images = conf.images.map((i) => i.name + "=" + i.dockerfile).join(" ");
  const push = lane === "trusted" ? conf.images.map((i) => i.name + "=" + i.repository).join(" ") : "";
  const buildArgs = buildArgsFor(b, conf, version, created);
  const source = "https://github.com/" + OWNER + "/" + b.repo;
  const labels = [
    "org.opencontainers.image.source=" + source,
    "org.opencontainers.image.url=" + source,
    "org.opencontainers.image.revision=" + b.sha,
    "org.opencontainers.image.version=" + version,
    "org.opencontainers.image.title=" + b.repo,
    "org.opencontainers.image.created=" + created,
  ].join(" ");
  const vars = {
    CI_REPO: b.repo,
    CI_SHA: b.sha,
    CI_REF: b.ref,
    CI_KIND: b.kind,
    CI_BUILD_NUMBER: b.number != null ? String(b.number) : "",
    CI_VERSION: version,
    CI_CLONE_URL: cloneUrl(b.repo),
    CI_IMAGES: images,
    CI_BUILD_ARGS: buildArgs,
    CI_LABELS: labels,
    CI_PUSH: push,
    CI_TAGS: lane === "trusted" ? tags.join(" ") : "",
  };
  const envList = Object.entries(vars).map(([name, value]) => ({ name, value }));
  for (const c of containersOf(spec)) c.env = [...(c.env || []), ...envList];

  for (const v of spec.volumes || []) {
    if (v.name === "cache" && v.persistentVolumeClaim) {
      v.persistentVolumeClaim.claimName = "ci-cache-" + b.repo + "-" + lane;
    }
    if (v.name === "deploy-key" && v.secret) {
      v.secret.items = [
        { key: b.repo, path: "identity" },
        { key: "known_hosts", path: "known_hosts" },
      ];
    }
  }
  spec.restartPolicy = "Never";

  const labelsOut = {
    ...(podMeta.labels || {}),
    "app.kubernetes.io/managed-by": MANAGED_BY,
    [LABEL + "repo"]: b.repo,
    [LABEL + "lane"]: lane,
    [LABEL + "kind"]: b.kind,
    ...(b.pr ? { [LABEL + "pr"]: String(b.pr) } : {}),
  };
  const annotations = {
    [LABEL + "sha"]: b.sha,
    [LABEL + "ref"]: b.ref,
    [LABEL + "seq"]: String(Date.now()).padStart(15, "0") + "-" + String(seqCounter++).padStart(6, "0"),
    [LABEL + "tags"]: tags.join(" "),
    [LABEL + "version"]: version,
    ...(b.number != null ? { [LABEL + "build-number"]: String(b.number) } : {}),
  };
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: { name: jobName(b), labels: labelsOut, annotations },
    spec: {
      suspend: true,
      backoffLimit: 0,
      activeDeadlineSeconds: Number(cfg.activeDeadlineSeconds || 3600),
      ttlSecondsAfterFinished: Number(cfg.jobTtlSeconds || 259200),
      template: { metadata: { labels: labelsOut, annotations: podMeta.annotations || {} }, spec },
    },
  };
}

let seqCounter = 0;

async function enqueue(b) {
  const name = jobName(b);
  if (!NAME_RE.test(name)) {
    log("error", "job name not valid; skipping build", { name });
    return;
  }
  if (b.kind === "pr") await supersede(b);
  try {
    await k8s("POST", nsPath("jobs"), await jobFor(b));
  } catch (err) {
    if (err.status === 409) return; // already queued by an earlier attempt
    // Server or network trouble (fetch throws a TypeError with a cause):
    // leave state unsaved so that the next sync retries.
    const transient = err.status ? err.status >= 500 || err.status === 429 : Boolean(err.cause);
    if (transient) throw err;
    // Anything else (a template that fails the checks above, an invalid
    // Job) will not fix itself on retry: report it on the commit and move on.
    log("error", "build not queued", { job: name, err: err.message });
    await postStatus(b.repo, b.sha, "error", "Build could not be queued; see dispatcher log", null, b.kind);
    return;
  }
  log("info", "queued", { job: name, repo: b.repo, kind: b.kind, sha: b.sha, number: b.number });
  await postStatus(b.repo, b.sha, "pending", "Queued" + (b.number != null ? " as build " + b.number : ""), name, b.kind);
}

// A newer push to a pull request replaces its builds that have not started.
async function supersede(b) {
  const sel = encodeURIComponent("app.kubernetes.io/managed-by=" + MANAGED_BY + "," + LABEL + "repo=" + b.repo + "," + LABEL + "pr=" + b.pr);
  const jobs = await k8s("GET", nsPath("jobs") + "?labelSelector=" + sel);
  for (const j of jobs.items) {
    if (!j.spec.suspend || j.metadata.annotations[LABEL + "sha"] === b.sha) continue;
    await k8s("DELETE", nsPath("jobs") + "/" + j.metadata.name + "?propagationPolicy=Background").catch(() => {});
    await postStatus(b.repo, j.metadata.annotations[LABEL + "sha"], "error", "Superseded by a newer push", null, "pr");
    log("info", "superseded", { job: j.metadata.name });
  }
}

function finished(job) {
  const c = (job.status && job.status.conditions) || [];
  if (c.some((x) => x.type === "Complete" && x.status === "True")) return "success";
  if (c.some((x) => x.type === "Failed" && x.status === "True")) return "failure";
  return null;
}

let kickTimer = null;
function kick() {
  if (kickTimer) return;
  kickTimer = setTimeout(() => {
    kickTimer = null;
    serialize("jobs", schedule).catch((err) => log("error", "schedule failed", { err: err.message }));
  }, 500);
}

// Release the next queued Job of each repository/lane and report finished ones.
async function schedule() {
  const sel = encodeURIComponent("app.kubernetes.io/managed-by=" + MANAGED_BY);
  const jobs = (await k8s("GET", nsPath("jobs") + "?labelSelector=" + sel)).items;
  const lanes = new Map();
  for (const j of jobs) {
    const result = finished(j);
    if (result && j.metadata.annotations[LABEL + "reported"] !== "true") await report(j, result);
    const key = j.metadata.labels[LABEL + "repo"] + "/" + j.metadata.labels[LABEL + "lane"];
    if (!lanes.has(key)) lanes.set(key, { running: 0, queued: [] });
    const lane = lanes.get(key);
    if (result) continue;
    if (j.spec.suspend) lane.queued.push(j);
    else lane.running++;
  }
  for (const [key, lane] of lanes) {
    if (lane.running || !lane.queued.length) continue;
    lane.queued.sort((a, b) =>
      a.metadata.annotations[LABEL + "seq"].localeCompare(b.metadata.annotations[LABEL + "seq"]));
    const j = lane.queued[0];
    await k8s("PATCH", nsPath("jobs") + "/" + j.metadata.name, { spec: { suspend: false } }, "application/merge-patch+json");
    log("info", "started", { job: j.metadata.name, lane: key });
    await postStatus(j.metadata.labels[LABEL + "repo"], j.metadata.annotations[LABEL + "sha"], "pending", "Running", j.metadata.name, j.metadata.labels[LABEL + "kind"]);
  }
}

async function podOf(jobName_) {
  const sel = encodeURIComponent("batch.kubernetes.io/job-name=" + jobName_);
  const pods = await k8s("GET", nsPath("pods") + "?labelSelector=" + sel);
  return pods.items[0] || null;
}

// Steps in execution order, with exit codes and timings.
function steps(pod) {
  const out = [];
  const statuses = [
    ...((pod && pod.status && pod.status.initContainerStatuses) || []),
    ...((pod && pod.status && pod.status.containerStatuses) || []),
  ];
  const sidecars = new Set(((pod && pod.spec.initContainers) || []).filter((c) => c.restartPolicy === "Always").map((c) => c.name));
  for (const s of statuses) {
    const t = (s.state && s.state.terminated) || (s.lastState && s.lastState.terminated) || null;
    const started = t ? Date.parse(t.startedAt) : s.state && s.state.running ? Date.parse(s.state.running.startedAt) : NaN;
    const ended = t ? Date.parse(t.finishedAt) : NaN;
    out.push({
      name: s.name,
      sidecar: sidecars.has(s.name),
      exitCode: t ? t.exitCode : null,
      reason: t ? t.reason : s.state && s.state.waiting ? s.state.waiting.reason : s.state && s.state.running ? "Running" : "",
      ms: ended - started,
    });
  }
  return out;
}

async function podLogs(pod) {
  let text = "";
  const names = [...(pod.spec.initContainers || []), ...pod.spec.containers].map((c) => c.name);
  for (const name of names) {
    const body = await k8sText(nsPath("pods") + "/" + pod.metadata.name + "/log?timestamps=true&container=" + encodeURIComponent(name));
    text += "\n===== " + name + " =====\n" + (body || "(no log)\n");
  }
  return text;
}

function summary(job, result, pod) {
  const a = job.metadata.annotations;
  const st = pod ? steps(pod) : [];
  const start = Date.parse(job.status.startTime || job.metadata.creationTimestamp);
  const end = Date.parse(job.status.completionTime || (job.status.conditions || []).map((c) => c.lastTransitionTime).sort().pop());
  const lines = [
    "build:    " + job.metadata.name,
    "result:   " + result,
    "repo:     " + OWNER + "/" + job.metadata.labels[LABEL + "repo"],
    "ref:      " + a[LABEL + "ref"],
    "commit:   " + a[LABEL + "sha"],
    "version:  " + a[LABEL + "version"],
    "tags:     " + (!a[LABEL + "tags"] ? "(none, not pushed)"
      : result === "success" ? a[LABEL + "tags"] : "(not pushed) " + a[LABEL + "tags"]),
    "started:  " + (job.status.startTime || "?"),
    "duration: " + fmtDuration(end - start),
    "",
    "steps:",
    ...st.map((s) => "  " + s.name.padEnd(10) + (s.sidecar ? " (service)" : "") +
      "  " + (s.exitCode != null ? "exit " + s.exitCode
        : result === "success" || result === "failure" ? "not run" : String(s.reason || "waiting")) +
      (s.ms >= 0 ? "  " + fmtDuration(s.ms) : "")),
  ];
  return { text: lines.join("\n") + "\n", steps: st, ms: end - start };
}

async function report(job, result) {
  const name = job.metadata.name;
  const repo = job.metadata.labels[LABEL + "repo"];
  const sha = job.metadata.annotations[LABEL + "sha"];
  let pod = null;
  try {
    pod = await podOf(name);
  } catch {}
  const sum = summary(job, result, pod);
  const logs = pod ? await podLogs(pod).catch((err) => "\n(logs unavailable: " + err.message + ")\n") : "\n(pod not found)\n";
  await fsp.mkdir(LOG_DIR, { recursive: true });
  await fsp.writeFile(path.join(LOG_DIR, name + ".log"), sum.text + logs);

  let desc;
  if (result === "success") {
    desc = (job.metadata.annotations[LABEL + "tags"] ? "Pushed " + job.metadata.annotations[LABEL + "tags"].split(" ")[0] : "Tests and image builds passed") +
      " in " + fmtDuration(sum.ms);
  } else {
    const failed = sum.steps.find((s) => !s.sidecar && s.exitCode != null && s.exitCode !== 0);
    const reason = (job.status.conditions || []).find((c) => c.type === "Failed");
    desc = failed ? "Failed in step " + failed.name + " after " + fmtDuration(sum.ms)
      : "Failed: " + ((reason && (reason.reason || reason.message)) || "unknown");
  }
  await postStatus(repo, sha, result === "success" ? "success" : "failure", desc, name, job.metadata.labels[LABEL + "kind"]);
  await k8s("PATCH", nsPath("jobs") + "/" + name,
    { metadata: { annotations: { [LABEL + "reported"]: "true" } } }, "application/merge-patch+json");
  log("info", "finished", { job: name, result, duration: fmtDuration(sum.ms), description: desc });
}

// ---------------------------------------------------------------- github

// Tag builds report under their own context so that a release build and the
// main-branch build of the same commit do not overwrite each other.
async function postStatus(repo, sha, st, description, job, kind) {
  const token = readText(path.join(SECRETS_DIR, "github", "status_token"));
  if (!token) return;
  const api = (cfg.githubApi || "https://api.github.com").replace(/\/+$/, "");
  const body = {
    state: st,
    context: kind === "tag" ? cfg.releaseStatusContext || "cluster/release" : cfg.statusContext || "cluster/build",
    description: description.slice(0, 140),
    ...(job && LOG_BASE_URL ? { target_url: LOG_BASE_URL + "/builds/" + job } : {}),
  };
  try {
    const res = await fetch(api + "/repos/" + OWNER + "/" + repo + "/statuses/" + sha, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        "User-Agent": "ci-dispatcher",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) log("warn", "commit status not accepted", { repo, sha, status: res.status });
  } catch (err) {
    log("warn", "commit status failed", { repo, sha, err: err.message });
  }
}

// ---------------------------------------------------------------- webhook

function verifySignature(secret, body, header) {
  if (!secret || typeof header !== "string" || !header.startsWith("sha256=")) return false;
  const given = Buffer.from(header.slice(7), "hex");
  const want = crypto.createHmac("sha256", secret).update(body).digest();
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}

function drop(res, code, why, fields) {
  log("warn", "webhook dropped", { why, ...fields });
  res.writeHead(code, { "Content-Type": "text/plain" });
  res.end(http.STATUS_CODES[code] + "\n");
}

function hookHandler(req, res) {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/healthz") {
    res.writeHead(200);
    return res.end("ok\n");
  }
  const m = /^\/hooks\/github\/([a-z0-9-]+)$/.exec(url.pathname);
  const fields = {
    path: url.pathname.slice(0, 100),
    delivery: String(req.headers["x-github-delivery"] || "").slice(0, 64),
    event: String(req.headers["x-github-event"] || "").slice(0, 32),
    from: String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").slice(0, 100),
  };
  if (!m || !Object.hasOwn(REPOS, m[1])) {
    req.resume();
    return drop(res, 404, "unknown path", fields);
  }
  if (req.method !== "POST") {
    req.resume();
    return drop(res, 405, "method", fields);
  }
  const repo = m[1];
  if (Number(req.headers["content-length"] || 0) > MAX_HOOK_BYTES) {
    req.resume();
    return drop(res, 413, "too large", fields);
  }
  const chunks = [];
  let size = 0;
  let aborted = false;
  req.on("data", (c) => {
    size += c.length;
    if (size > MAX_HOOK_BYTES && !aborted) {
      aborted = true;
      drop(res, 413, "too large", fields);
      req.destroy();
    } else chunks.push(c);
  });
  req.on("end", () => {
    if (aborted) return;
    const body = Buffer.concat(chunks);
    const secret = readText(path.join(SECRETS_DIR, "hooks", repo));
    if (!verifySignature(secret, body, req.headers["x-hub-signature-256"])) {
      return drop(res, 401, secret ? "bad signature" : "no secret configured", fields);
    }
    let payload;
    try {
      payload = JSON.parse(body.toString("utf8"));
    } catch {
      return drop(res, 400, "bad json", fields);
    }
    const named = String((payload.repository && payload.repository.full_name) || "").toLowerCase();
    if (named !== (OWNER + "/" + repo).toLowerCase()) {
      return drop(res, 403, "repository mismatch", { ...fields, named: named.slice(0, 100) });
    }
    if (fields.event === "ping") {
      res.writeHead(200);
      return res.end("pong\n");
    }
    if (!["push", "pull_request", "create"].includes(fields.event)) {
      res.writeHead(204);
      return res.end();
    }
    log("info", "webhook accepted", { repo, ...fields });
    requestSync(repo, "webhook " + fields.event);
    res.writeHead(202);
    res.end("accepted\n");
  });
}

// ---------------------------------------------------------------- log viewer

async function logHandler(req, res) {
  const url = new URL(req.url, "http://x");
  try {
    if (url.pathname === "/healthz") {
      res.writeHead(200);
      return res.end("ok\n");
    }
    if (url.pathname === "/" || url.pathname === "/builds" || url.pathname === "/builds/") return await indexPage(res);
    const m = /^\/builds\/([a-z0-9-]+?)(\.log)?$/.exec(url.pathname);
    if (!m || !NAME_RE.test(m[1])) {
      res.writeHead(404);
      return res.end("not found\n");
    }
    const file = path.join(LOG_DIR, m[1] + ".log");
    if (fs.existsSync(file)) {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      return fs.createReadStream(file).pipe(res);
    }
    let job;
    try {
      job = await k8s("GET", nsPath("jobs") + "/" + m[1]);
    } catch {
      res.writeHead(404);
      return res.end("not found (logs are kept " + (cfg.logRetentionDays || 30) + " days)\n");
    }
    const pod = await podOf(m[1]);
    const text = summary(job, job.spec.suspend ? "queued" : "running", pod).text + (pod ? await podLogs(pod) : "");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end("<!doctype html><meta http-equiv=refresh content=10><title>" + escapeHtml(m[1]) +
      "</title><pre>" + escapeHtml(text) + "</pre>");
  } catch (err) {
    log("error", "log page failed", { err: err.message });
    res.writeHead(500);
    res.end("error\n");
  }
}

async function indexPage(res) {
  const rows = new Map();
  const files = await fsp.readdir(LOG_DIR).catch(() => []);
  for (const f of files) {
    if (!f.endsWith(".log")) continue;
    const st = await fsp.stat(path.join(LOG_DIR, f));
    const head = (await fsp.readFile(path.join(LOG_DIR, f), "utf8")).slice(0, 600);
    const result = (/^result:\s+(\S+)/m.exec(head) || [])[1] || "";
    const duration = (/^duration:\s+(\S+)/m.exec(head) || [])[1] || "";
    rows.set(f.slice(0, -4), { t: st.mtimeMs, result, duration });
  }
  const sel = encodeURIComponent("app.kubernetes.io/managed-by=" + MANAGED_BY);
  const jobs = (await k8s("GET", nsPath("jobs") + "?labelSelector=" + sel)).items;
  for (const j of jobs) {
    if (rows.has(j.metadata.name)) continue;
    rows.set(j.metadata.name, { t: Date.parse(j.metadata.creationTimestamp), result: j.spec.suspend ? "queued" : finished(j) || "running", duration: "" });
  }
  const list = [...rows.entries()].sort((a, b) => b[1].t - a[1].t).slice(0, 300);
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end("<!doctype html><meta http-equiv=refresh content=30><title>builds</title><style>body{font-family:monospace}td{padding:2px 12px}</style><table>" +
    list.map(([n, r]) => "<tr><td>" + new Date(r.t).toISOString().slice(0, 19).replace("T", " ") + "</td><td><a href=\"/builds/" + n + "\">" +
      escapeHtml(n) + "</a></td><td>" + escapeHtml(r.result) + "</td><td>" + escapeHtml(r.duration) + "</td></tr>").join("") + "</table>");
}

async function pruneLogs() {
  const days = Number(cfg.logRetentionDays || 30);
  const maxBytes = Number(cfg.logMaxBytes || 2 * 1024 ** 3);
  const files = [];
  for (const f of await fsp.readdir(LOG_DIR).catch(() => [])) {
    const p = path.join(LOG_DIR, f);
    const st = await fsp.stat(p).catch(() => null);
    if (st && st.isFile()) files.push({ p, t: st.mtimeMs, size: st.size });
  }
  files.sort((a, b) => a.t - b.t);
  let total = files.reduce((n, f) => n + f.size, 0);
  const cutoff = Date.now() - days * 86400_000;
  for (const f of files) {
    if (f.t < cutoff || total > maxBytes) {
      await fsp.unlink(f.p).catch(() => {});
      total -= f.size;
    }
  }
}

// ---------------------------------------------------------------- main

async function main() {
  await fsp.mkdir(WORK_DIR, { recursive: true });
  await fsp.mkdir(LOG_DIR, { recursive: true });
  const hooks = http.createServer(hookHandler);
  hooks.requestTimeout = 30_000;
  hooks.headersTimeout = 10_000;
  hooks.maxHeadersCount = 100;
  hooks.listen(HOOK_PORT);
  const logs = http.createServer((req, res) => void logHandler(req, res));
  logs.listen(LOG_PORT);
  log("info", "started", { namespace: NS, repos: Object.keys(REPOS), tagMode: cfg.tagMode || "test", hookPort: HOOK_PORT, logPort: LOG_PORT });

  for (const repo of Object.keys(REPOS)) requestSync(repo, "startup");
  setInterval(() => {
    for (const repo of Object.keys(REPOS)) requestSync(repo, "poll");
  }, Number(cfg.pollSeconds || 300) * 1000);
  setInterval(kick, 10_000);
  setInterval(() => void pruneLogs(), 3600_000);
  kick();

  const stop = () => {
    log("info", "stopping");
    hooks.close();
    logs.close();
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

export { verifySignature, versionAndTags, buildArgsFor, jobName, assertCredentialScope };

if (!env.DISPATCHER_NO_MAIN) {
  main().catch((err) => {
    log("error", "fatal", { err: err.stack });
    process.exit(1);
  });
}
