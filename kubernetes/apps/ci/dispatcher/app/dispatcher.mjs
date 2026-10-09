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
//   - Rehearsal: for a repository with a `rehearsal` setting, every new api
//     image of a main commit gets a migration rehearsal (PodTemplate named
//     there): the image deployed onto a copy of production, reported as
//     config.rehearsalStatusContext on its commit. Images come from this
//     dispatcher's own main builds and from the registry, whose tags are
//     listed on every poll (rehearsal.registryTags: the images production
//     deploys, built elsewhere). Each image is rehearsed once. A ConfigMap
//     labelled dispatcher.ci/request=rehearsal asks for one by hand (see
//     takeRehearsalRequests).
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
const REGISTRY_URL = (env.REGISTRY_URL || "").replace(/\/+$/, ""); // tests only
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

const deploymentPath = (ns, name) =>
  "/apis/apps/v1/namespaces/" + encodeURIComponent(ns) + "/deployments/" + encodeURIComponent(name);

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
  if (b.kind === "rehearsal") return "rehearsal";
  return b.kind === "pr" ? "untrusted" : "trusted";
}

function jobName(b) {
  if (b.kind === "rehearsal") return b.repo + "-rehearsal-" + sha7(b.sha) + "-" + b.suffix;
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
  await takeRehearsalRequests();
  const sel = encodeURIComponent("app.kubernetes.io/managed-by=" + MANAGED_BY);
  const jobs = (await k8s("GET", nsPath("jobs") + "?labelSelector=" + sel)).items;
  const lanes = new Map();
  for (const j of jobs) {
    const result = finished(j);
    if (result && j.metadata.annotations[LABEL + "reported"] !== "true") await report(j, result);
    if (await sweepRehearsal(j, result)) continue;
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
  await startRehearsals(jobs);
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
      // What the step wrote to its termination log (rehearsal steps: one
      // plain line); never its log output.
      message: t && t.message ? String(t.message).trim() : "",
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
    ...(a[LABEL + "candidate"] ? [
      "image:    " + a[LABEL + "candidate"],
      "deployed: " + a[LABEL + "previous"],
    ] : [
      "tags:     " + (!a[LABEL + "tags"] ? "(none, not pushed)"
        : result === "success" ? a[LABEL + "tags"] : "(not pushed) " + a[LABEL + "tags"]),
    ]),
    "started:  " + (job.status.startTime || "?"),
    "duration: " + fmtDuration(end - start),
    "",
    "steps:",
    ...st.map((s) => "  " + s.name.padEnd(10) + (s.sidecar ? " (service)" : "") +
      "  " + (s.exitCode != null ? "exit " + s.exitCode
        : result === "success" || result === "failure" ? "not run" : String(s.reason || "waiting")) +
      (s.ms >= 0 ? "  " + fmtDuration(s.ms) : "") +
      (s.message ? "\n" + " ".repeat(14) + s.message.split("\n")[0] : "")),
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
  const kind = job.metadata.labels[LABEL + "kind"];
  let desc;
  let outcome = result;
  if (kind === "rehearsal") {
    const o = rehearsalOutcome(job, result, sum);
    desc = o.description;
    outcome = o.state;
  } else if (result === "success") {
    desc = (job.metadata.annotations[LABEL + "tags"] ? "Pushed " + job.metadata.annotations[LABEL + "tags"].split(" ")[0] : "Tests and image builds passed") +
      " in " + fmtDuration(sum.ms);
  } else {
    const failed = sum.steps.find((s) => !s.sidecar && s.exitCode != null && s.exitCode !== 0);
    const reason = (job.status.conditions || []).find((c) => c.type === "Failed");
    desc = failed ? "Failed in step " + failed.name + " after " + fmtDuration(sum.ms)
      : "Failed: " + ((reason && (reason.reason || reason.message)) || "unknown");
  }
  await fsp.mkdir(LOG_DIR, { recursive: true });
  await fsp.writeFile(path.join(LOG_DIR, name + ".log"),
    sum.text.replace(/^result: .*$/m, "result:   " + outcome).replace("\nsteps:", "\nstatus:   " + desc + "\n\nsteps:") + logs);
  if (kind === "rehearsal") {
    const ref = job.metadata.annotations[LABEL + "ref"] || "";
    await postRehearsalStatus(repo, sha, outcome, desc, name,
      ref.startsWith("requested by hand: ") ? ref.slice("requested by hand: ".length) : null);
  }
  else await postStatus(repo, sha, result === "success" ? "success" : "failure", desc, name, kind);
  await k8s("PATCH", nsPath("jobs") + "/" + name,
    { metadata: { annotations: { [LABEL + "reported"]: "true" } } }, "application/merge-patch+json");
  log("info", "finished", { job: name, result, duration: fmtDuration(sum.ms), description: desc });

  if (kind === "rehearsal") {
    // The log is saved; the pod held a copy of production in memory. Remove
    // it now rather than at the Job's TTL.
    await deleteJob(name);
  } else if (kind === "main" && result === "success" && REPOS[repo] && REPOS[repo].rehearsal) {
    const tag = (job.metadata.annotations[LABEL + "tags"] || "").split(" ").filter(Boolean)[0];
    if (tag) {
      await enqueueRehearsal({
        repo, sha, tag, source: name,
      });
    }
  }
}

// ---------------------------------------------------------------- rehearsal

// A migration rehearsal (stockpile#330) deploys a new api image onto a copy
// of the production database, from the PodTemplate named in the repository's
// `rehearsal` setting, and boots the image production runs beside it.
//
//   - Queue: a waiting rehearsal is a ConfigMap labelled
//     dispatcher.ci/rehearsal-queue=<repo>, named like its Job. The Job is
//     only built when it starts (startRehearsals), so the deployed image it
//     boots, and the production data it copies, are those of that moment.
//     One rehearsal runs per repository at a time.
//   - Once per image: an automatic rehearsal is named after its image's
//     digest (or reference, when the registry can't say), and is not run
//     again once its log is kept. A re-pushed tag is a new digest, so it is
//     rehearsed again. A request by hand always runs.
//   - Already deployed: when production already runs the candidate's commit
//     or a later one, nothing is run. The status is success only if a
//     rehearsal of that commit passed before; otherwise error "Not
//     rehearsed: deployed before its rehearsal ran" (unproven, not a pass).
//     Requests by hand, and the first registry image seen, run regardless.
//   - What sticks: a failure the change caused (migrate, seed, the ready and
//     read checks) posts "failure", and no later pending, error or success
//     replaces it on that commit (postRehearsalStatus) until a rehearsal
//     requested by hand passes on it, which clears it and logs why. Trouble
//     of the rehearsal's own (copy, image pull, eviction, timeout, the
//     services) posts "error", which a later result replaces.
//   - The copy lives only in the pod's memory: the dispatcher deletes the Job
//     once it has saved the log, and sweeps any finished one it finds.

const REHEARSAL_DB_SECRET = "ci-rehearsal-db";
const REHEARSAL_PULL_SECRET = "ci-registry-pull";
const SHA_RE = /^[0-9a-f]{40}$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const QUEUE = LABEL + "rehearsal-queue";

function rehearsalRepository(repo) {
  const conf = REPOS[repo];
  const image = conf.images.find((i) => i.name === conf.rehearsal.image);
  if (!image) throw new Error("rehearsal image " + conf.rehearsal.image + " is not one of " + repo + "'s images");
  return image.repository;
}

// An image of `repository`: by tag, digest, or tag pinned to a digest.
function inRepository(image, repository) {
  return typeof image === "string" && image.startsWith(repository) &&
    /^(:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}(@sha256:[0-9a-f]{64})?|@sha256:[0-9a-f]{64})$/.test(image.slice(repository.length));
}

// The tag of an image reference ("" when it has none).
function tagOf(image) {
  const noDigest = image.split("@")[0];
  const colon = noDigest.lastIndexOf(":");
  return colon > noDigest.lastIndexOf("/") ? noDigest.slice(colon + 1) : "";
}

// The image the repository's production api runs right now.
async function previousImage(repo) {
  const p = REPOS[repo].rehearsal.previous;
  const dep = await k8s("GET", deploymentPath(p.namespace, p.deployment));
  const c = (dep.spec.template.spec.containers || []).find((x) => x.name === (p.container || "main"));
  if (!c || !c.image) throw new Error("no container " + (p.container || "main") + " in " + p.namespace + "/" + p.deployment);
  return c.image;
}

// Only `copy` may see the read-only production credential, and nothing may
// see the registry push credential.
function assertRehearsalScope(spec) {
  if (JSON.stringify(spec).includes(PUSH_SECRET)) throw new Error("rehearsal template references the push credential");
  if (spec.shareProcessNamespace || spec.hostNetwork || spec.hostPID || spec.hostIPC) {
    throw new Error("rehearsal template shares host or process namespaces");
  }
  if (spec.automountServiceAccountToken !== false) throw new Error("rehearsal template mounts a service account token");
  const dbVolumes = (spec.volumes || [])
    .filter((v) => JSON.stringify(v).includes('"' + REHEARSAL_DB_SECRET + '"'))
    .map((v) => v.name);
  for (const c of containersOf(spec)) {
    const sees = JSON.stringify([c.env || [], c.envFrom || []]).includes('"' + REHEARSAL_DB_SECRET + '"') ||
      (c.volumeMounts || []).some((m) => dbVolumes.includes(m.name));
    if (sees && c.name !== "copy") throw new Error("container " + c.name + " would receive the production database credential");
  }
}

// The Job for rehearsal `r` ({repo, sha, suffix, image, source}) from
// PodTemplate `tmpl`, with `previous` as the deployed image. Created running:
// it is built only when its turn comes. Pure, for tests.
function rehearsalJob(r, tmpl, previous) {
  const conf = REPOS[r.repo];
  const repository = rehearsalRepository(r.repo);
  if (!SHA_RE.test(r.sha)) throw new Error("not a commit sha: " + String(r.sha).slice(0, 60));
  if (!inRepository(r.image, repository)) throw new Error("candidate image is not in " + repository);
  if (!inRepository(previous, repository)) throw new Error("deployed image " + String(previous).slice(0, 120) + " is not in " + repository);

  const b = { ...r, kind: "rehearsal" };
  const lane = laneOf(b);
  const podMeta = tmpl.template.metadata || {};
  const spec = structuredClone(tmpl.template.spec);
  assertRehearsalScope(spec);

  const db = (r.repo + "_rehearsal_" + sha7(r.sha)).replace(/[^a-z0-9_]/g, "_");
  const vars = {
    CI_REPO: r.repo,
    CI_SHA: r.sha,
    CI_KIND: "rehearsal",
    CI_CANDIDATE_IMAGE: r.image,
    CI_PREVIOUS_IMAGE: previous,
    CI_REHEARSAL_DB: db,
  };
  const envList = Object.entries(vars).map(([name, value]) => ({ name, value }));
  for (const c of containersOf(spec)) {
    if (c.image === "candidate") c.image = r.image;
    else if (c.image === "previous") c.image = previous;
    else if (!/@sha256:[0-9a-f]{64}$/.test(c.image || "")) {
      throw new Error("rehearsal container " + c.name + " has an unpinned image");
    }
    c.env = [...(c.env || []), ...envList];
  }
  spec.restartPolicy = "Never";

  const labelsOut = {
    ...(podMeta.labels || {}),
    "app.kubernetes.io/managed-by": MANAGED_BY,
    [LABEL + "repo"]: r.repo,
    [LABEL + "lane"]: lane,
    [LABEL + "kind"]: "rehearsal",
  };
  const annotations = {
    [LABEL + "sha"]: r.sha,
    [LABEL + "ref"]: r.hand ? "requested by hand: " + r.hand : r.source ? "after " + r.source : "requested",
    [LABEL + "seq"]: String(Date.now()).padStart(15, "0") + "-" + String(seqCounter++).padStart(6, "0"),
    [LABEL + "tags"]: "",
    [LABEL + "version"]: tagOf(r.image) || r.image.slice(repository.length + 1),
    [LABEL + "candidate"]: r.image,
    [LABEL + "previous"]: previous,
  };
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: { name: jobName(b), labels: labelsOut, annotations },
    spec: {
      suspend: false,
      backoffLimit: 0,
      activeDeadlineSeconds: Number(conf.rehearsal.activeDeadlineSeconds || 1800),
      // Backstop only: the dispatcher deletes the Job once it is reported.
      ttlSecondsAfterFinished: Number(conf.rehearsal.ttlSecondsAfterFinished || 3600),
      template: { metadata: { labels: labelsOut, annotations: podMeta.annotations || {} }, spec },
    },
  };
}

// Name suffix of an automatic rehearsal: the image's digest when known.
function imageSuffix(key) {
  return "i" + crypto.createHash("sha256").update(key).digest("hex").slice(0, 8);
}

// The kept logs of rehearsals of `sha` (header fields), except `except`.
async function rehearsalLogs(repo, sha, except) {
  const prefix = repo + "-rehearsal-" + sha7(sha) + "-";
  const out = [];
  for (const f of await fsp.readdir(LOG_DIR).catch(() => [])) {
    if (!f.startsWith(prefix) || !f.endsWith(".log") || f === except + ".log") continue;
    const file = path.join(LOG_DIR, f);
    const head = (await fsp.readFile(file, "utf8").catch(() => "")).slice(0, 2000);
    const field = (k) => ((new RegExp("^" + k + ":\\s+(.*)$", "m").exec(head) || [])[1] || "").trim();
    if (field("commit") !== sha) continue;
    const st = await fsp.stat(file).catch(() => null);
    out.push({ job: f.slice(0, -4), result: field("result"), status: field("status"),
      hand: field("ref").startsWith("requested by hand"), t: st ? st.mtimeMs : 0 });
  }
  return out.sort((a, b) => a.t - b.t);
}

// The failure that sticks on `sha`, if any: the latest one not followed by
// a pass requested by hand.
async function stuckFailure(repo, sha, except) {
  let stuck = null;
  for (const l of await rehearsalLogs(repo, sha, except)) {
    if (l.result === "failure") stuck = l;
    else if (l.result === "success" && l.hand) stuck = null;
  }
  return stuck;
}

// Commit status for a rehearsal. A failure the change caused sticks: on a
// commit that has one, nothing but another failure is posted, except for a
// rehearsal requested by hand (`hand`: its reason), whose results are
// always posted and whose pass clears the failure.
async function postRehearsalStatus(repo, sha, st, description, job, hand) {
  if (st !== "failure") {
    const failed = await stuckFailure(repo, sha, job);
    if (failed && !hand) {
      log("info", "rehearsal status kept at failure", { sha, failed: failed.job, not_posted: st, description });
      return;
    }
    if (failed && st === "success") {
      log("info", "rehearsal failure cleared by a request by hand", { sha, failed: failed.job, job, reason: hand });
    }
  }
  await postStatus(repo, sha, st, description, job, "rehearsal");
}

async function writeRehearsalLog(name, lines) {
  await fsp.mkdir(LOG_DIR, { recursive: true });
  await fsp.writeFile(path.join(LOG_DIR, name + ".log"), lines.join("\n") + "\n");
}

// Queue rehearsal `r` ({repo, sha, image, digest?, source, suffix?}). True
// when it is queued, already queued, or already rehearsed.
async function enqueueRehearsal(r) {
  let name = r.repo + "-rehearsal";
  try {
    const repository = rehearsalRepository(r.repo);
    if (!r.image) r = { ...r, image: repository + ":" + r.tag };
    if (!SHA_RE.test(r.sha)) throw new Error("not a commit sha");
    if (!inRepository(r.image, repository)) throw new Error("candidate image is not in " + repository);
    if (!r.digest && !r.suffix && !r.image.includes("@")) {
      r = { ...r, digest: await registryDigest(r.image).catch(() => null) };
    }
    // Pin the tag to what was found, so the rehearsal runs that exact image.
    if (r.digest && !r.image.includes("@")) r = { ...r, image: r.image + "@" + r.digest };
    if (!r.suffix) r = { ...r, suffix: imageSuffix(r.digest || r.image) };
    name = jobName({ ...r, kind: "rehearsal" });
    if (!NAME_RE.test(name)) throw new Error("job name not valid: " + name);
    if (fs.existsSync(path.join(LOG_DIR, name + ".log"))) {
      log("info", "image already rehearsed", { job: name, image: r.image });
      return true;
    }
    await k8s("POST", nsPath("configmaps"), {
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: { name, labels: { "app.kubernetes.io/managed-by": MANAGED_BY, [QUEUE]: r.repo } },
      data: {
        repo: r.repo, sha: r.sha, image: r.image, suffix: r.suffix, source: r.source || "",
        hand: r.hand || "", force: r.force ? "true" : "",
        seq: String(Date.now()).padStart(15, "0") + "-" + String(seqCounter++).padStart(6, "0"),
      },
    });
  } catch (err) {
    if (err.status === 409) return true; // already queued
    log("error", "rehearsal not queued", { job: name, err: err.message });
    if (SHA_RE.test(String(r.sha))) {
      await postRehearsalStatus(r.repo, r.sha, "error", "Rehearsal could not be queued: " + err.message.split("\n")[0], null, r.hand);
    }
    return false;
  }
  log("info", "rehearsal queued", { job: name, repo: r.repo, sha: r.sha, image: r.image });
  await postRehearsalStatus(r.repo, r.sha, "pending", "Queued: rehearse " + (tagOf(r.image) || "image") + " on a copy of production", name, r.hand);
  kick();
  return true;
}

// Is the ExternalSecret `name` (in this namespace) synced?
async function secretReady(name) {
  try {
    const es = await k8s("GET", "/apis/external-secrets.io/v1/namespaces/" + NS + "/externalsecrets/" + name);
    return ((es.status && es.status.conditions) || []).some((c) => c.type === "Ready" && c.status === "True");
  } catch {
    return false;
  }
}

// Production runs `previous`. Is the candidate commit that one or older?
async function deployedCommit(repo, previous) {
  const m = /main-([0-9a-f]{7,40})-b[0-9]+$/.exec(tagOf(previous));
  return m ? resolveCommit(repo, m[1]) : null;
}

async function isAncestor(repo, a, b) {
  try {
    await git(repo, ["merge-base", "--is-ancestor", a, b]);
    return true;
  } catch {
    return false;
  }
}

// Start the oldest queued rehearsal of each repository with none running.
async function startRehearsals(jobs) {
  for (const repo of Object.keys(REPOS).filter((x) => REPOS[x].rehearsal)) {
    if (jobs.some((j) => j.metadata.labels[LABEL + "kind"] === "rehearsal" &&
      j.metadata.labels[LABEL + "repo"] === repo && !finished(j) && !j.metadata.deletionTimestamp)) continue;
    const sel = encodeURIComponent(QUEUE + "=" + repo);
    const queued = (await k8s("GET", nsPath("configmaps") + "?labelSelector=" + sel)).items
      .sort((a, b) => String(a.data.seq).localeCompare(String(b.data.seq)));
    for (const cm of queued) {
      // The Job first, then the queue entry: a crash in between leaves the
      // entry, and taking it again finds the Job (409) or its kept log.
      const started = await startRehearsal(cm.metadata.name, cm.data);
      await k8s("DELETE", nsPath("configmaps") + "/" + cm.metadata.name).catch(() => {});
      if (started) break;
    }
  }
}

// True when a Job was created (or exists already).
async function startRehearsal(name, d) {
  const r = { repo: d.repo, sha: d.sha, image: d.image, suffix: d.suffix, source: d.source || null,
    hand: d.hand || null, force: d.force === "true" };
  const conf = REPOS[r.repo].rehearsal;
  const post = (st, desc, job) => postRehearsalStatus(r.repo, r.sha, st, desc, job, r.hand);
  try {
    if (!r.hand && fs.existsSync(path.join(LOG_DIR, name + ".log"))) {
      log("info", "image already rehearsed", { job: name });
      return false;
    }
    if (!(await secretReady(REHEARSAL_DB_SECRET))) {
      await post("error", "Rehearsal not configured: database credential missing (" + REHEARSAL_DB_SECRET + " not synced); skipped", null);
      log("warn", "rehearsal skipped: database credential missing", { job: name });
      return false;
    }
    if (!(await secretReady(REHEARSAL_PULL_SECRET))) {
      await post("error", "Rehearsal not configured: registry pull credential missing (" + REHEARSAL_PULL_SECRET + " not synced); skipped", null);
      log("warn", "rehearsal skipped: pull credential missing", { job: name });
      return false;
    }
    // What production runs now, not when this was queued.
    const previous = await previousImage(r.repo);
    const deployed = r.force ? null : await deployedCommit(r.repo, previous);
    if (deployed && (deployed === r.sha || await isAncestor(r.repo, r.sha, deployed))) {
      // Nothing to run: production has moved this far already. Proven only
      // if a rehearsal of this commit passed before.
      const passed = (await rehearsalLogs(r.repo, r.sha, name)).some((l) => l.result === "success");
      const where = "production runs " + (tagOf(previous) || "this commit") + (deployed === r.sha ? "" : ", a later commit");
      const st = passed ? "success" : "error";
      const desc = passed ? "Already deployed (" + where + "); its rehearsal passed earlier"
        : "Not rehearsed: deployed before its rehearsal ran (" + where + ")";
      await writeRehearsalLog(name, [
        "build:    " + name, "result:   " + (passed ? "deployed" : "not-rehearsed"), "repo:     " + OWNER + "/" + r.repo,
        "commit:   " + r.sha, "image:    " + r.image, "deployed: " + previous, "status:   " + desc,
      ]);
      await post(st, desc, name);
      log("info", "rehearsal not run: already deployed", { job: name, deployed: previous, proven: passed });
      return false;
    }
    const tmpl = await k8s("GET", nsPath("podtemplates") + "/" + conf.template);
    const job = rehearsalJob(r, tmpl, previous);
    await k8s("POST", nsPath("jobs"), job);
    log("info", "started", { job: name, lane: r.repo + "/rehearsal", image: r.image, previous, hand: r.hand || undefined });
    await post("pending", "Running: rehearse " + (tagOf(r.image) || "image") + " on a copy of production", name);
    return true;
  } catch (err) {
    if (err.status === 409) return true; // that Job exists already
    log("error", "rehearsal not started", { job: name, err: err.message });
    await post("error", "Rehearsal could not start: " + err.message.split("\n")[0], null);
    return false;
  }
}

// Commit status text: the failing step's own line, else the step in plain
// words; on success what the copy, migrate and checks steps reported.
const REHEARSAL_STEPS = {
  postgres: "starting the rehearsal database",
  redis: "starting the rehearsal Redis",
  copy: "copying production",
  migrate: "migrating the copy",
  seed: "seeding the migrated copy",
  "api-ready": "waiting for the new api",
  "worker-ready": "waiting for the new worker",
  reads: "reading the copy with the new build",
  "previous-ready": "waiting for the deployed release's api",
  "previous-reads": "reading the copy with the deployed release",
};

// The steps whose failure the change caused: they post "failure", which
// sticks. Any other way a rehearsal ends badly is the rehearsal's own
// trouble (copy, services, image pull, eviction, timeout): "error".
const CHANGE_STEPS = ["migrate", "seed", "api-ready", "worker-ready", "reads", "previous-ready", "previous-reads"];

// { state: success | failure | error, description }
function rehearsalOutcome(job, result, sum) {
  const took = " (" + fmtDuration(sum.ms) + ")";
  if (result === "success") {
    const migrate = (sum.steps.find((s) => s.name === "migrate") || {}).message || "";
    const m = /^Applied (\d+) new migration/.exec(migrate);
    const what = m ? m[1] + " new migration" + (m[1] === "1" ? "" : "s") + " applied" : "no new migrations";
    return { state: "success", description: "Passed on a copy of production: " + what + "; new api, worker and the deployed release ready" + took };
  }
  const failed = sum.steps.find((s) => !s.sidecar && s.exitCode != null && s.exitCode !== 0);
  if (failed && CHANGE_STEPS.includes(failed.name)) {
    return { state: "failure", description: failed.message || "Failed " + (REHEARSAL_STEPS[failed.name] || "in step " + failed.name) + took };
  }
  const reason = (job.status.conditions || []).find((c) => c.type === "Failed");
  const running = sum.steps.find((s) => !s.sidecar && s.exitCode == null) || {};
  let why;
  if (failed) why = failed.message || "failed " + (REHEARSAL_STEPS[failed.name] || "in step " + failed.name);
  else if (reason && reason.reason === "DeadlineExceeded") why = "timed out" + (REHEARSAL_STEPS[running.name] ? " " + REHEARSAL_STEPS[running.name] : "") + took;
  else why = "the rehearsal pod did not finish (" + ((reason && (reason.reason || reason.message)) || "unknown") + ")";
  return { state: "error", description: "Rehearsal itself failed, not the change: " + why };
}

function rehearsalDescription(job, result, sum) {
  return rehearsalOutcome(job, result, sum).description;
}

async function deleteJob(name) {
  try {
    await k8s("DELETE", nsPath("jobs") + "/" + name + "?propagationPolicy=Background");
    log("info", "deleted", { job: name });
  } catch (err) {
    if (err.status !== 404) log("warn", "job not deleted; the sweep will retry", { job: name, err: err.message });
  }
}

// Finished rehearsals are deleted once reported (report() does it; this
// catches one whose delete failed). True when the Job is done with.
async function sweepRehearsal(job, result) {
  if (job.metadata.labels[LABEL + "kind"] !== "rehearsal") return false;
  if (result && !job.metadata.deletionTimestamp) await deleteJob(job.metadata.name);
  return true;
}

// A rehearsal by hand: a ConfigMap in this namespace labelled
// dispatcher.ci/request=rehearsal, with data
//   repo:  stockpile
//   sha:   <full commit sha>        (the commit status goes on it)
//   image: <tag or full reference in the repository's rehearsal image repo>
//   reason: <why, logged; e.g. "post-merge check", "retry after a flake">
// It runs even when production already has that commit, and its results
// are always posted; its pass clears an earlier failure on the commit.
// Whoever may create ConfigMaps in this namespace may ask. The request is
// deleted once taken; a bad one is logged and dropped.
async function takeRehearsalRequests() {
  const sel = encodeURIComponent(LABEL + "request=rehearsal");
  let list;
  try {
    list = await k8s("GET", nsPath("configmaps") + "?labelSelector=" + sel);
  } catch (err) {
    if (err.status !== 403) log("warn", "rehearsal requests not read", { err: err.message });
    return;
  }
  for (const cm of list.items) {
    const d = cm.data || {};
    await k8s("DELETE", nsPath("configmaps") + "/" + cm.metadata.name).catch(() => {});
    const repo = String(d.repo || "");
    if (!Object.hasOwn(REPOS, repo) || !REPOS[repo].rehearsal) {
      log("warn", "rehearsal request dropped: no rehearsal for repository", { request: cm.metadata.name, repo: repo.slice(0, 40) });
      continue;
    }
    const repository = rehearsalRepository(repo);
    const image = String(d.image || "").includes("/") ? String(d.image) : repository + ":" + String(d.image || "");
    if (!SHA_RE.test(String(d.sha || "")) || !inRepository(image, repository)) {
      log("warn", "rehearsal request dropped: needs a full sha and an image in " + repository, { request: cm.metadata.name });
      continue;
    }
    const reason = String(d.reason || "no reason given").replace(/[^\x20-\x7e]/g, " ").slice(0, 120);
    log("info", "rehearsal requested", { request: cm.metadata.name, repo, sha: d.sha, image, reason });
    await enqueueRehearsal({ repo, sha: d.sha, suffix: "r" + Date.now().toString(36), image, source: null, hand: reason, force: true });
  }
}

// ---------------------------------------------------------------- registry

// Rehearse the images production deploys when something else builds them
// (today GitHub Actions; blookums flux-system/image-automation picks them by
// the same pattern). Every pollSeconds, apart from repository discovery (a
// slow registry never holds up builds): list the tags of the repository's
// rehearsal image, take the newest tags matching rehearsal.registryTags
// (first group the commit's short sha, resolved in the git mirror; second
// the build number), look up each one's digest and queue each tag@digest
// not seen before. On first sight only the newest is rehearsed. State:
// s.rehearsalSeen = { "<tag>@<digest>": "queued" | "skipped" | <tries> },
// kept to the tags examined.

// The pull credential (ci-registry-pull, docker config JSON), if mounted.
function registryAuth(host) {
  const text = readText(path.join(SECRETS_DIR, "registry-pull", ".dockerconfigjson"));
  if (!text) return null;
  try {
    const a = JSON.parse(text).auths || {};
    return (a[host] && a[host].auth) || null;
  } catch {
    return null;
  }
}

function splitRepository(repository) {
  const slash = repository.indexOf("/");
  return { host: repository.slice(0, slash), name: repository.slice(slash + 1) };
}

async function registryToken(repository) {
  const { host, name } = splitRepository(repository);
  const basic = registryAuth(host);
  if (!basic) throw new Error("no pull credential for " + host);
  const res = await fetch((REGISTRY_URL || "https://" + host) + "/token?service=" + encodeURIComponent(host) +
    "&scope=" + encodeURIComponent("repository:" + name + ":pull"), {
    headers: { Authorization: "Basic " + basic, "User-Agent": "ci-dispatcher" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error("registry token: HTTP " + res.status);
  const tok = await res.json();
  return tok.token || tok.access_token;
}

// All tags of `repository` ("host/owner/name"), via the registry API.
async function registryTags(repository, bearer) {
  const { host, name } = splitRepository(repository);
  const base = REGISTRY_URL || "https://" + host;
  const tags = [];
  let next = "/v2/" + name + "/tags/list?n=1000";
  for (let page = 0; next && page < 50; page++) {
    const res = await fetch(base + next, {
      headers: { Authorization: "Bearer " + bearer, Accept: "application/json", "User-Agent": "ci-dispatcher" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error("registry tags: HTTP " + res.status);
    tags.push(...(((await res.json()) || {}).tags || []));
    const link = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get("link") || "");
    next = link ? (link[1].startsWith("http") ? new URL(link[1]).pathname + new URL(link[1]).search : link[1]) : null;
  }
  return tags;
}

const MANIFEST_TYPES = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

// The digest a tag points at now.
async function registryDigest(image, bearer) {
  const repository = image.slice(0, image.lastIndexOf(":"));
  const { host, name } = splitRepository(repository);
  const tag = tagOf(image);
  const res = await fetch((REGISTRY_URL || "https://" + host) + "/v2/" + name + "/manifests/" + encodeURIComponent(tag), {
    method: "HEAD",
    headers: { Authorization: "Bearer " + (bearer || await registryToken(repository)), Accept: MANIFEST_TYPES, "User-Agent": "ci-dispatcher" },
    signal: AbortSignal.timeout(20_000),
  });
  const digest = res.headers.get("docker-content-digest") || "";
  if (!res.ok || !DIGEST_RE.test(digest)) throw new Error("registry digest of " + tag + ": HTTP " + res.status);
  return digest;
}

async function resolveCommit(repo, short) {
  try {
    const out = await git(repo, ["rev-parse", "--verify", "--quiet", short + "^{commit}"]);
    const sha = out.trim();
    return SHA_RE.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

async function pollRegistry(repo) {
  const conf = REPOS[repo].rehearsal;
  if (!conf || !conf.registryTags || !fs.existsSync(deployKey(repo))) return;
  // The slow part, outside the state lock.
  const repository = rehearsalRepository(repo);
  const look = Number(conf.registryLookback || 10);
  let found;
  try {
    const bearer = await registryToken(repository);
    const re = new RegExp(conf.registryTags);
    const newest = (await registryTags(repository, bearer)).map((t) => ({ tag: t, m: re.exec(t) })).filter((x) => x.m)
      .map((x) => ({ tag: x.tag, short: x.m[1], build: Number(x.m[2]) }))
      .sort((a, b) => a.build - b.build).slice(-look);
    found = [];
    for (const x of newest) {
      const digest = await registryDigest(repository + ":" + x.tag, bearer).catch(() => null);
      if (digest) found.push({ ...x, digest, key: x.tag + "@" + digest });
    }
  } catch (err) {
    log("warn", "registry tags not listed; rehearsals of registry images wait", { repo, err: err.message });
    return;
  }
  // The bookkeeping, in order with discovery.
  await serialize("state", async () => {
    await loadState();
    const s = repoState(repo);
    const first = !s.rehearsalSeen;
    const seen = s.rehearsalSeen || {};
    const fresh = found.filter((x) => typeof seen[x.key] !== "string");
    const take = first ? fresh.slice(-1) : fresh.slice(-Number(conf.maxRegistryBacklog || 5));
    for (const x of fresh) if (!take.includes(x)) seen[x.key] = "skipped";
    for (const x of take) {
      const sha = await resolveCommit(repo, x.short);
      // The first image seen is rehearsed even if production runs it: that
      // proves the pipeline against production as it is.
      const ok = sha && await enqueueRehearsal({ repo, sha, image: repository + ":" + x.tag, digest: x.digest, source: "registry tag " + x.tag, force: first });
      if (ok) {
        seen[x.key] = "queued";
        continue;
      }
      // Commit not in the mirror yet, or not queued (an error status is
      // posted then); a few more polls, then leave it.
      seen[x.key] = (Number(seen[x.key]) || 0) + 1;
      if (seen[x.key] >= 6) {
        seen[x.key] = "skipped";
        log("warn", "registry image not rehearsed", { repo, tag: x.tag, why: sha ? "could not queue" : "no such commit on main" });
      }
    }
    const kept = new Set(found.map((x) => x.key));
    s.rehearsalSeen = Object.fromEntries(Object.entries(seen).filter(([k]) => kept.has(k)));
    delete s.rehearsalTags; // earlier format
    await saveState();
    if (first) log("info", "registry tags recorded", { repo, tags: found.length, rehearsing: take.map((x) => x.tag) });
  });
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
    context: kind === "tag" ? cfg.releaseStatusContext || "cluster/release"
      : kind === "rehearsal" ? cfg.rehearsalStatusContext || "cluster/rehearsal"
      : cfg.statusContext || "cluster/build",
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
    // A rehearsal ran on production data: its pages show the summary and
    // each step's one line, never the containers' output, which stays in
    // the store (kubectl -n ci exec deploy/dispatcher -- cat /data/logs/...).
    const rehearsal = m[1].includes("-rehearsal-");
    const file = path.join(LOG_DIR, m[1] + ".log");
    if (fs.existsSync(file)) {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      if (rehearsal) {
        const text = await fsp.readFile(file, "utf8");
        return res.end(text.split("\n=====")[0].trimEnd() + "\n\n(step output is kept in the dispatcher's log store only)\n");
      }
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
    const text = summary(job, job.spec.suspend ? "queued" : "running", pod).text + (pod && !rehearsal ? await podLogs(pod) : "");
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
  const registry = () => {
    for (const repo of Object.keys(REPOS)) {
      void pollRegistry(repo).catch((err) => log("error", "registry poll failed", { repo, err: err.message }));
    }
  };
  setTimeout(registry, 15_000);
  setInterval(registry, Number(cfg.pollSeconds || 300) * 1000);
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

export { verifySignature, versionAndTags, buildArgsFor, jobName, assertCredentialScope, rehearsalJob, assertRehearsalScope, rehearsalDescription, rehearsalOutcome, inRepository, imageSuffix, tagOf };

if (!env.DISPATCHER_NO_MAIN) {
  main().catch((err) => {
    log("error", "fatal", { err: err.stack });
    process.exit(1);
  });
}
