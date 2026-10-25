/** Owned fake HostFn executable only: verifies installed argv/process contracts, never deploys. */
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  chmodSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  executeHostFnDeploy,
  executeHostFnDeployAsync,
  Runner,
  MemoryLogFnClient,
} from "../dist/index.mjs";
import {
  MemoryStore,
  MemoryQueueClient,
  DEFAULT_QUEUE_NAME,
} from "@cifn/control-plane";
const root = mkdtempSync(join(tmpdir(), "cifn-hostfn-native-")),
  executable = join(root, "hostfn"),
  args = join(root, "args");
let complete = false;
function script(code) {
  writeFileSync(executable, `#!${process.execPath}\n${code}\n`);
  chmodSync(executable, 0o700);
}
try {
  script(
    "require('node:fs').writeFileSync(process.env.ARGS,JSON.stringify(process.argv.slice(2)));process.stdout.write((process.env.SECRET??'')+'\\n');",
  );
  const sentinel = join(root, "forbidden"),
    environment = `production; printf injected > ${sentinel}`;
  assert.equal(
    executeHostFnDeploy({
      environment,
      workspace: root,
      executable,
      env: { ARGS: args },
    }).success,
    true,
  );
  assert.equal(existsSync(sentinel), false);
  assert.ok(JSON.parse(readFileSync(args, "utf8")).includes(environment));
  const direct = await executeHostFnDeployAsync({
    environment: "--help",
    local: true,
    workspace: root,
    executable,
    env: { ARGS: args, SECRET: "fixture-private" },
  });
  assert.equal(direct.success, true);
  assert.deepEqual(JSON.parse(readFileSync(args, "utf8")), [
    "deploy",
    "--local",
    "--ci",
    "--",
    "--help",
  ]);
  assert.equal(JSON.stringify(direct).includes("fixture-private"), false);
  const store = new MemoryStore(),
    queue = new MemoryQueueClient(),
    logs = new MemoryLogFnClient(),
    spec = {
      on: { workflow_dispatch: {} },
      jobs: {
        deploy: {
          "runs-on": "hostfn-runner",
          steps: [
            {
              uses: "hostfn/deploy",
              with: { environment: "production", ci: false },
            },
          ],
        },
      },
    };
  const run = store.createRun({
    pipelineSpec: spec,
    trigger: { type: "workflow_dispatch" },
  });
  const runner = new Runner({
    store,
    queue,
    logClient: logs,
    runnerType: "hostfn-runner",
    hostFnExecutable: executable,
    pipelineSpecs: new Map([[run.id, spec]]),
  });
  await queue.enqueue(DEFAULT_QUEUE_NAME, {
    runId: run.id,
    jobKey: "deploy",
    jobSpec: spec.jobs.deploy,
    env: { ARGS: args, SECRET: "runner-private" },
    secretKeys: ["SECRET"],
  });
  await runner.processNextJob();
  assert.equal(store.getRun(run.id).status, "success");
  assert.equal(
    JSON.stringify(logs.getAllLines(run.id)).includes("runner-private"),
    false,
  );
  assert.deepEqual(JSON.parse(readFileSync(args, "utf8")), [
    "deploy",
    "--local",
    "--ci",
    "--",
    "production",
  ]);
  const pidFile = join(root, "pid");
  script(
    "require('node:fs').writeFileSync(process.env.PID_FILE,String(process.pid));process.on('SIGTERM',()=>{});process.stdout.write('active\\n');setInterval(()=>{},1000);",
  );
  const abort = new AbortController();
  const cancelled = await executeHostFnDeployAsync({
    environment: "production",
    workspace: root,
    executable,
    env: { PID_FILE: pidFile },
    signal: abort.signal,
    onLines: (lines) => {
      if (lines.includes("active")) abort.abort();
    },
  });
  assert.equal(cancelled.success, false);
  assert.throws(() => process.kill(Number(readFileSync(pidFile, "utf8")), 0));
  complete = true;
  console.log(
    JSON.stringify({
      passed: true,
      installedHostFnArgv: true,
      syncLiteralCompatibility: true,
      asyncOwnedCancellation: true,
      runnerRequiredCiLocal: true,
      streamedRedaction: true,
      actualDeployment: false,
    }),
  );
} finally {
  if (complete) {
    rmSync(root, { recursive: true, force: true });
    assert.equal(existsSync(root), false);
  } else console.error("Owned HostFn fixture evidence retained: " + root);
}
