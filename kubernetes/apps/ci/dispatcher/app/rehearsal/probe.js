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

const fs = require("node:fs");

const [what, url, waitArg, stayArg, healthUrl] = process.argv.slice(2);
const waitMs = Number(waitArg || 180) * 1000;
const stayMs = Number(stayArg || 0) * 1000;

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

async function main() {
  const start = Date.now();
  let last = { ok: false, answer: "not asked yet" };
  let said = "";
  while (Date.now() - start < waitMs) {
    last = await probe();
    if (last.answer !== said) {
      console.log(Math.round((Date.now() - start) / 1000) + "s " + what + ": " + last.answer);
      said = last.answer;
    }
    if (last.ok) break;
    await sleep(2000);
  }
  if (!last.ok) {
    say("The " + what + " was not ready on the migrated copy within " + Math.round(waitMs / 1000) + "s (last answer: " + last.answer + ")");
    process.exit(1);
  }
  const readyAt = Date.now();
  while (Date.now() - readyAt < stayMs) {
    await sleep(5000);
    const now = await probe();
    if (!now.ok) {
      say("The " + what + " became ready, then failed its checks on the migrated copy (answer: " + now.answer + ")");
      process.exit(1);
    }
  }
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
  say("The " + what + " is ready on the migrated copy after " + Math.round((readyAt - start) / 1000) + "s" +
    (stayMs ? " and stayed ready " + Math.round(stayMs / 1000) + "s" : "") + outbound);
}

main();
