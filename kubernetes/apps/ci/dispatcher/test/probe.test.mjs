// Unit tests for the rehearsal's readiness probe (../app/rehearsal/probe.js).
//
//   node --test kubernetes/apps/ci/dispatcher/test/*.test.mjs
//
// The real script against a local server that answers what each test scripts.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PROBE = new URL("../app/rehearsal/probe.js", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

// A server whose /ready answers the listed statuses in turn (the last one for
// ever after), /route `routeStatus`; the Host each /route request came with.
async function server(readyStatuses, routeStatus = 404) {
  const hosts = [];
  let i = 0;
  const srv = http.createServer((req, res) => {
    if (req.url === "/route") {
      hosts.push(req.headers.host);
      res.writeHead(routeStatus);
      return res.end();
    }
    const status = readyStatuses[Math.min(i++, readyStatuses.length - 1)];
    res.writeHead(status);
    res.end(status === 200 ? "ready" : "role-too-broad");
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { base: "http://127.0.0.1:" + srv.address().port, hosts, close: () => srv.close() };
}

function run(url, wait, stay, env = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const p = spawn(process.execPath, [PROBE, "public api", url, String(wait), String(stay)], {
      env: { ...process.env, ...env },
    });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("close", (code) => resolve({ code, out, ms: Date.now() - started }));
  });
}

describe("probe", { concurrency: true }, () => {
  test("without the options, one bad answer during the stay still fails", async () => {
    const s = await server([200, 503, 200]);
    const r = await run(s.base + "/ready", 10, 12);
    s.close();
    assert.equal(r.code, 1);
    assert.match(r.out, /became ready, then failed/);
  });

  test("PROBE_MISSES: two misses in a row pass", async () => {
    const s = await server([200, 503, 503, 200]);
    const r = await run(s.base + "/ready", 10, 15, { PROBE_MISSES: "2" });
    s.close();
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /stayed ready 15s/);
  });

  test("PROBE_MISSES: a third miss in a row fails", async () => {
    const s = await server([200, 503, 503, 503, 200]);
    const r = await run(s.base + "/ready", 10, 20, { PROBE_MISSES: "2" });
    s.close();
    assert.equal(r.code, 1);
    assert.match(r.out, /became ready, then failed.*503 role-too-broad/);
  });

  test("never ready fails when the wait is over, with the last answer", async () => {
    const s = await server([503]);
    const r = await run(s.base + "/ready", 3, 0, { PROBE_MISSES: "2" });
    s.close();
    assert.equal(r.code, 1);
    assert.match(r.out, /not ready on the migrated copy within 3s.*503 role-too-broad/);
  });

  test("PROBE_DOWN_FILE: its line fails the probe at once, not after the wait", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "probe-"));
    const down = path.join(dir, "down");
    fs.writeFileSync(down, "Public api exited (1): REFUSING TO START: remove X\n");
    const s = await server([503]);
    const r = await run(s.base + "/ready", 120, 0, { PROBE_DOWN_FILE: down });
    s.close();
    fs.rmSync(dir, { recursive: true });
    assert.equal(r.code, 1);
    assert.match(r.out, /Public api exited \(1\): REFUSING TO START: remove X/);
    assert.ok(r.ms < 10_000, "took " + r.ms + "ms");
  });

  test("PROBE_DOWN_FILE: going down during the stay fails at the next look", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "probe-"));
    const down = path.join(dir, "down");
    const s = await server([200]);
    setTimeout(() => fs.writeFileSync(down, "Public api exited (137): see the log\n"), 2000);
    const r = await run(s.base + "/ready", 10, 60, { PROBE_DOWN_FILE: down });
    s.close();
    fs.rmSync(dir, { recursive: true });
    assert.equal(r.code, 1);
    assert.match(r.out, /Public api exited \(137\)/);
    assert.ok(r.ms < 20_000, "took " + r.ms + "ms");
  });

  test("PROBE_ROUTE: a 404 passes, asked for a host that looks like a shop's", async () => {
    const s = await server([200], 404);
    const r = await run(s.base + "/ready", 10, 0, { PROBE_ROUTE: s.base + "/route" });
    s.close();
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /\/route answers 404/);
    assert.deepEqual(s.hosts, ["no-such-shop.stockpile-rehearsal.com"]);
  });

  test("PROBE_ROUTE: a 5xx fails, after the misses allowed", async () => {
    const s = await server([200], 500);
    const r = await run(s.base + "/ready", 10, 0, { PROBE_ROUTE: s.base + "/route", PROBE_MISSES: "2" });
    s.close();
    assert.equal(r.code, 1);
    assert.match(r.out, /is ready but \/route failed \(500\)/);
    assert.equal(s.hosts.length, 3);
  });
});
