/** Actual built server + FlowFn scheduler + SQLite, owned loopback only. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
const directory = await mkdtemp(join(tmpdir(), "cifn-cron-owned-")),
  children = [];
const key = randomBytes(32).toString("base64"),
  api = "owned-cron-api",
  token = "owned-cron-registration";
const pipeline = {
  id: "minute",
  cronExpression: "* * * * *",
  pipelineRef: { repo: "owned/repository", ref: "main" },
  spec: {
    on: { schedule: [{ cron: "* * * * *" }] },
    jobs: {
      build: {
        "runs-on": "default",
        steps: [{ run: "never executed by fixture" }],
      },
    },
  },
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function stop(item) {
  if (item.child.exitCode !== null || item.child.signalCode !== null) return;
  item.child.kill("SIGTERM");
  let timer;
  const ended = await Promise.race([
    item.exit.then(() => true),
    new Promise((resolve) => (timer = setTimeout(() => resolve(false), 5000))),
  ]);
  clearTimeout(timer);
  if (!ended) {
    item.child.kill("SIGKILL");
    let killTimer;
    const killed = await Promise.race([
      item.exit.then(() => true),
      new Promise(
        (resolve) => (killTimer = setTimeout(() => resolve(false), 5000)),
      ),
    ]);
    clearTimeout(killTimer);
    if (!killed) throw Error("Owned cron process exit unconfirmed");
    throw Error("Graceful cron shutdown timed out");
  }
}
async function start() {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("../dist/server.js", import.meta.url))],
    {
      env: {
        ...process.env,
        PORT: "0",
        CIFN_API_KEYS: api,
        CIFN_RUNNER_REGISTRATION_TOKEN: token,
        CIFN_STORE_ADAPTER: "sqlite",
        CIFN_SQLITE_PATH: join(directory, "state.sqlite"),
        CIFN_STORE_ENCRYPTION_KEY: key,
        CIFN_STORE_NAMESPACE: "cron-fixture",
        CIFN_QUEUE_ADAPTER: "memory",
        CIFN_ARTIFACTS_ADAPTER: "memory",
        CIFN_SECRETS_ADAPTER: "memory",
        CIFN_LOGS_ADAPTER: "memory",
        CIFN_CRON_PIPELINES: JSON.stringify([pipeline]),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const item = { child, exit: once(child, "exit") };
  children.push(item);
  let output = "";
  child.stderr.on("data", (chunk) => (output += chunk));
  let timer;
  const port = await new Promise((resolve, reject) => {
    timer = setTimeout(
      () => reject(Error("Cron server startup timed out")),
      10000,
    );
    child.once("error", reject);
    child.once("exit", () => reject(Error("Cron server exited: " + output)));
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const match = /listening on port (\d+)/.exec(output);
      if (match) resolve(Number(match[1]));
    });
  }).finally(() => clearTimeout(timer));
  item.request = async (path, body, credential = api) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${credential}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    assert.ok(response.ok);
    const result = await response.json();
    assert.equal(result.ok, true);
    return result.data;
  };
  return item;
}
try {
  // Avoid interpreting a legitimate boundary during startup as an early run.
  const remaining = 60000 - (Date.now() % 60000);
  if (remaining < 20000) await delay(remaining + 100);
  const first = await start();
  const initial = await first.request("/api/v1/runs");
  assert.equal(initial.runs.length, 0);
  // Readiness starts strictly before the next occurrence; real wall-clock waiting, no fake production clock.
  const next = Math.floor(Date.now() / 60000) * 60000 + 60000;
  if (next - Date.now() > 1500) {
    await delay(500);
    assert.equal((await first.request("/api/v1/runs")).runs.length, 0);
  }
  let runs = [];
  const deadline = next + 5000;
  while (Date.now() < deadline) {
    runs = (await first.request("/api/v1/runs")).runs;
    if (runs.length) break;
    await delay(100);
  }
  assert.equal(runs.length, 1);
  assert.equal(runs[0].trigger.type, "schedule");
  assert.equal(runs[0].status, "queued");
  const registered = await first.request("/api/v1/runners/register", {
    token,
    labels: ["default"],
  });
  const assignment = await first.request(
    "/api/v1/runners/heartbeat",
    { runnerId: registered.runnerId },
    registered.runnerSecret,
  );
  assert.equal(assignment.job.runId, runs[0].runId);
  await stop(first);
  // A delayed host must not turn a legitimate next occurrence into a false duplicate.
  assert.ok(
    Date.now() < next + 50000,
    "Fixture exceeded same-minute restart observation window",
  );
  const second = await start();
  await delay(300);
  assert.ok(
    Date.now() < next + 60000,
    "Fixture crossed its bounded restart observation window",
  );
  assert.equal((await second.request("/api/v1/runs")).runs.length, 1);
  await stop(second);
  console.log(
    JSON.stringify({
      passed: true,
      actualFlowScheduler: true,
      builtServerRegistration: true,
      noEarlyOccurrence: true,
      queuedRunClaimed: true,
      reopenNoSameMinuteDuplicate: true,
      distributedOwnership: false,
      missedOccurrencesBackfilled: false,
    }),
  );
} finally {
  const cleanup = await Promise.allSettled(children.map(stop));
  if (cleanup.some((result) => result.status === "rejected"))
    throw Error("Owned cron process cleanup failed; retained " + directory);
  await rm(directory, { recursive: true, force: true });
}
