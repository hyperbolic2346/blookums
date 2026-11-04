// Waits for a readiness endpoint of a server in the rehearsal pod.
//
//   node probe.js <what> <url> <wait seconds> [<stay seconds>] [<health url>]
//
// Passes once <url> answers 200 and keeps answering 200 for <stay seconds>
// (the worker's self-checks run every 15s and turn its /readyz only after
// two failures, so a worker is watched for a while). Writes one plain line
// to /dev/termination-log either way. Bodies are bare status words
// ("ready", "schema-behind", {"ok":false}); only those are repeated.
//
// With <health url> (the api's /api/health), the api must also report
// outbound mode "readonly" (stockpile#329) when it reports a mode at all:
// a rehearsed api that says "live" fails. Images from before the guard
// report none; that is noted, not failed (the network policy still holds).
//
// Only the public api's step sets these (the others behave as without them):
//   PROBE_DOWN_FILE  its server's step writes this file when the server went
//                    down: the line in it fails the probe at once
//   PROBE_MISSES     answers in a row that may fail while it stays ready
//   PROBE_ROUTE      asked last, for a host no shop has (the shop lookup runs
//                    as the role; no listing data needed): a 404 is the right
//                    answer, a 5xx or none fails

const fs = require("node:fs");
const http = require("node:http");

const [what, url, waitArg, stayArg, healthUrl] = process.argv.slice(2);
const waitMs = Number(waitArg || 180) * 1000;
const stayMs = Number(stayArg || 0) * 1000;
const downFile = process.env.PROBE_DOWN_FILE;
const misses = Number(process.env.PROBE_MISSES || 0);
const route = process.env.PROBE_ROUTE;

function say(line) {
  try {
    fs.writeFileSync("/dev/termination-log", line.slice(0, 400));
  } catch {}
  console.log(line);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function probe() {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    const body = (await res.text()).replace(/\s+/g, " ").slice(0, 60);
    return { ok: res.status === 200, answer: res.status + " " + body };
  } catch (err) {
    return { ok: false, answer: "no answer (" + ((err.cause && err.cause.code) || err.name) + ")" };
  }
}

function failIfDown() {
  if (!downFile) return;
  let line = "";
  try {
    line = fs.readFileSync(downFile, "utf8").trim();
  } catch {
    return;
  }
  say(line || "The " + what + " went down");
  process.exit(1);
}

// Status of the route for a host no shop has, or a word when it doesn't answer.
function askRoute() {
  return new Promise((resolve) => {
    const req = http.get(route, { headers: { host: "no-such-shop.stockpile-rehearsal.com" }, timeout: 5000 }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (err) => resolve("no answer (" + (err.code || err.message) + ")"));
  });
}

async function checkRoute() {
  let answer;
  for (let i = 0; i <= misses; i++) {
    if (i) await sleep(2000);
    answer = await askRoute();
    if (typeof answer === "number" && answer < 500) return answer;
  }
  say("The " + what + " is ready but " + new URL(route).pathname + " failed (" + answer + ")");
  process.exit(1);
}

async function main() {
  const start = Date.now();
  let last = { ok: false, answer: "not asked yet" };
  let said = "";
  while (Date.now() - start < waitMs) {
    failIfDown();
    last = await probe();
    if (last.answer !== said) {
      console.log(Math.round((Date.now() - start) / 1000) + "s " + what + ": " + last.answer);
      said = last.answer;
    }
    if (last.ok) break;
    await sleep(2000);
  }
  if (!last.ok) {
    failIfDown();
    say("The " + what + " was not ready on the migrated copy within " + Math.round(waitMs / 1000) + "s (last answer: " + last.answer + ")");
    process.exit(1);
  }
  const readyAt = Date.now();
  let missed = 0;
  while (Date.now() - readyAt < stayMs) {
    await sleep(5000);
    failIfDown();
    const now = await probe();
    if (now.ok) {
      missed = 0;
    } else if (++missed > misses) {
      failIfDown();
      say("The " + what + " became ready, then failed its checks on the migrated copy (answer: " + now.answer + ")");
      process.exit(1);
    } else {
      console.log(what + ": missed one (" + now.answer + ")");
    }
  }
  failIfDown();
  let outbound = "";
  if (healthUrl) {
    let mode;
    try {
      const res = await fetch(healthUrl, { signal: AbortSignal.timeout(5000) });
      const body = await res.json();
      mode = body && body.outbound ? body.outbound.mode : undefined;
    } catch (err) {
      say("The " + what + " is ready but its /api/health did not answer (" + err.name + ")");
      process.exit(1);
    }
    if (mode === undefined) {
      console.log(what + ": this image reports no outbound mode (from before the outbound guard)");
    } else if (mode !== "readonly") {
      say("The " + what + " runs with outbound mode " + String(mode).slice(0, 20) + ", not readonly; refusing to go on");
      process.exit(1);
    } else {
      outbound = ", outside writes off";
    }
  }
  let routed = "";
  if (route) {
    routed = ", " + new URL(route).pathname + " answers " + (await checkRoute());
    failIfDown();
  }
  say("The " + what + " is ready on the migrated copy after " + Math.round((readyAt - start) / 1000) + "s" +
    (stayMs ? " and stayed ready " + Math.round(stayMs / 1000) + "s" : "") + outbound + routed);
}

main();
