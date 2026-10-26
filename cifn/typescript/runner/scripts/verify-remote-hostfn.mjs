/** Real HTTP/SQLite remote claim protocol with an owned fake executable; no deployment. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdtemp,
  writeFile,
  readFile,
  chmod,
  rm,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { RemoteRunner } from "../dist/index.mjs";
const root = await mkdtemp(join(tmpdir(), "cifn-remote-hostfn-")),
  exe = join(root, "hostfn"),
  witness = join(root, "witness"),
  pidFile = join(root, "pid"),
  key = randomBytes(32).toString("base64"),
  secret = "owned-hostfn-private-secret",
  token = "owned-registration";
const children = [];
let port = 0,
  output = "",
  clean = false;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hostFn = {
  executable: exe,
  timeoutMs: 15000,
  labels: ["hostfn-runner"],
  local: true,
};
await writeFile(
  exe,
  `#!${process.execPath}\nconst fs=require('node:fs');fs.appendFileSync(process.env.WITNESS,JSON.stringify(process.argv.slice(2))+'\\n');fs.writeFileSync(process.env.PID_FILE,String(process.pid));process.stdout.write('provider '+process.env.HOSTFN_SSH_KEY+'\\n');if(process.env.MODE==='wait'){process.on('SIGTERM',()=>{});setTimeout(()=>process.exit(0),5000);setInterval(()=>{},1000);}\n`,
);
await chmod(exe, 0o700);
function track(child) {
  const item = { child, exit: once(child, "exit") };
  children.push(item);
  child.stdout?.on("data", (chunk) => (output += chunk));
  child.stderr?.on("data", (chunk) => (output += chunk));
  return item;
}
async function stop(item, signal = "SIGTERM") {
  if (!item || item.child.exitCode !== null || item.child.signalCode !== null)
    return;
  item.child.kill(signal);
  let timer;
  let ended = await Promise.race([
    item.exit.then(() => true),
    new Promise((resolve) => (timer = setTimeout(() => resolve(false), 5000))),
  ]);
  clearTimeout(timer);
  if (!ended) {
    item.child.kill("SIGKILL");
    ended = await Promise.race([
      item.exit.then(() => true),
      new Promise(
        (resolve) => (timer = setTimeout(() => resolve(false), 5000)),
      ),
    ]);
    clearTimeout(timer);
    if (!ended) throw Error("Owned child exit uncertain");
  }
}
async function startControl() {
  const item = track(
    spawn(
      process.execPath,
      [
        fileURLToPath(
          new URL("../../control-plane/dist/server.js", import.meta.url),
        ),
      ],
      {
        env: {
          ...process.env,
          PORT: String(port),
          CIFN_API_KEYS: secret,
          CIFN_RUNNER_REGISTRATION_TOKEN: token,
          CIFN_STORE_ADAPTER: "sqlite",
          CIFN_SQLITE_PATH: join(root, "state.sqlite"),
          CIFN_STORE_ENCRYPTION_KEY: key,
          CIFN_STORE_NAMESPACE: "remote-hostfn",
          CIFN_QUEUE_ADAPTER: "memory",
          CIFN_ARTIFACTS_ADAPTER: "memory",
          CIFN_SECRETS_ADAPTER: "memory",
          CIFN_LOGS_ADAPTER: "memory",
          CIFN_CRON_PIPELINES: "[]",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    ),
  );
  let ready;
  item.child.stdout.on("data", (chunk) => {
    const match = /listening on port (\d+)/.exec(String(chunk));
    if (match) ready = Number(match[1]);
  });
  const end = Date.now() + 10000;
  while (!ready && Date.now() < end) {
    if (item.child.exitCode !== null) throw Error("Control exited");
    await delay(20);
  }
  assert.ok(ready, "Control startup");
  port = ready;
  return item;
}
async function request(path, body, credential = secret) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${credential}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  assert.ok(response.ok, `${path}: ${response.status}`);
  const result = await response.json();
  assert.equal(result.ok, true);
  return result.data;
}
async function makeRun(mode = "done") {
  return request("/api/v1/runs", {
    trigger: { type: "workflow_dispatch" },
    pipelineSpec: {
      on: { workflow_dispatch: {} },
      env: {
        WITNESS: witness,
        PID_FILE: pidFile,
        MODE: mode,
        HOSTFN_SSH_KEY: "${{ secrets.CIFN_API_KEYS }}",
      },
      jobs: {
        deploy: {
          "runs-on": "hostfn-runner",
          steps: [
            { uses: "hostfn/deploy", with: { environment: "production" } },
          ],
        },
      },
    },
  });
}
async function count() {
  try {
    return (await readFile(witness, "utf8")).trim().split("\n").length;
  } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }
}
async function waitCount(expected) {
  const end = Date.now() + 8000;
  while ((await count()) < expected && Date.now() < end) await delay(20);
  assert.equal(await count(), expected);
}
async function waitProviderExit() {
  let pid;
  try {
    pid = Number(await readFile(pidFile, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return;
      throw error;
    }
    await delay(25);
  }
  throw Error("Owned fake provider did not exit; evidence retained");
}
try {
  let control = await startControl();
  const registration = await request("/api/v1/runners/register", {
    token,
    labels: ["hostfn-runner"],
  });
  const options = {
    baseUrl: `http://127.0.0.1:${port}`,
    runnerId: registration.runnerId,
    runnerSecret: registration.runnerSecret,
    stateDirectory: join(root, "runner"),
    hostFn,
  };
  const run = await makeRun();
  let lost = false;
  const mutablePolicy = {...hostFn, labels:[...hostFn.labels]};
  const runner = new RemoteRunner({
    ...options, hostFn: mutablePolicy,
    fetch: async (input, init) => {
      const response = await fetch(input, init);
      if (String(input).endsWith("/claims/complete") && !lost) {
        lost = true;
        await response.arrayBuffer();
        throw Error("owned lost completion ACK");
      }
      return response;
    },
  });
  mutablePolicy.executable = '/not-the-admitted-executable'; mutablePolicy.labels.length = 0;
  await assert.rejects(runner.tick(), /owned lost completion ACK/);
  assert.equal(await count(), 1);
  assert.equal((await request(`/api/v1/runs/${run.runId}`)).status, "success");
  await stop(control);
  control = await startControl();
  await new RemoteRunner(options).tick();
  assert.equal(await count(), 1);
  const logs = JSON.stringify(
    await request(`/api/v1/runs/${run.runId}/jobs/deploy/logs`),
  );
  assert.equal(logs.includes(secret), false);
  assert.ok(logs.includes("***"));
  const cancelled = await makeRun("wait");
  const active = new RemoteRunner(options).tick();
  await waitCount(2);
  await request(`/api/v1/runs/${cancelled.runId}/cancel`, {});
  await active;
  await waitProviderExit();
  assert.equal(
    (await request(`/api/v1/runs/${cancelled.runId}`)).status,
    "cancelled",
  );
  await new RemoteRunner(options).tick();
  assert.equal(await count(), 2);
  const crashed = await makeRun("wait");
  const crashState = join(root, "crashed-runner");
  const child = track(
    spawn(
      process.execPath,
      [fileURLToPath(new URL("../dist/server.js", import.meta.url))],
      {
        env: {
          ...process.env,
          CIFN_CONTROL_PLANE_URL: options.baseUrl,
          CIFN_RUNNER_ID: options.runnerId,
          CIFN_RUNNER_SECRET: options.runnerSecret,
          CIFN_RUNNER_STATE_DIR: crashState,
          CIFN_HOSTFN_POLICY: JSON.stringify(hostFn),
          CIFN_POLL_INTERVAL_MS: "50",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    ),
  );
  await waitCount(3);
  await stop(child, "SIGKILL");
  await waitProviderExit();
  await stop(control);
  control = await startControl();
  await new RemoteRunner({ ...options, stateDirectory: crashState }).tick();
  assert.equal(await count(), 3);
  assert.equal(
    (await request(`/api/v1/runs/${crashed.runId}`)).status,
    "running",
  );
  for (const state of [options.stateDirectory, crashState])
    for (const name of await readdir(state)) {
      if (name.endsWith(".json"))
        assert.equal(
          (await readFile(join(state, name), "utf8")).includes(secret),
          false,
        );
    }
  for (const line of (await readFile(witness, "utf8")).trim().split("\n"))
    assert.deepEqual(JSON.parse(line), [
      "deploy",
      "--local",
      "--ci",
      "--",
      "production",
    ]);
  assert.equal(output.includes(secret), false);
  await stop(control);
  clean = true;
  console.log(
    JSON.stringify({
      passed: true,
      remoteHostFn: true,
      actualHttpSQLite: true,
      preparedSecretsRedacted: true,
      lostCompletionAckNoRerun: true,
      cancelledOwnedProcessClosed: true,
      killedRunnerUnknownNotReplayed: true,
      builtRunnerPolicy: true,
      executions: 3,
      actualDeployment: false,
    }),
  );
} finally {
  const results = await Promise.allSettled(children.map((item) => stop(item)));
  await waitProviderExit();
  if (results.some((result) => result.status === "rejected"))
    throw Error("Owned process cleanup uncertain; retained " + root);
  if (clean) await rm(root, { recursive: true, force: true });
  else console.error("Owned HostFn acceptance evidence retained: " + root);
}
