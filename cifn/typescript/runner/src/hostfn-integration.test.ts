import { test, expect, afterEach } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  existsSync,
  rmSync,
  chmodSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { executeHostFnDeploy } from "./steps/hostfn-deploy.js";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cifn-hostfn-owned-"));
  roots.push(root);
  const executable = join(root, "hostfn");
  writeFileSync(
    executable,
    `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.ARGS,JSON.stringify(process.argv.slice(2)));\n`,
  );
  chmodSync(executable, 0o700);
  return { root, executable };
}
test("hostile environment is one literal argument and never executes a second shell command", () => {
  const { root, executable } = fixture(),
    sentinel = join(root, "forbidden"),
    args = join(root, "args");
  const environment = `production; printf injected > ${sentinel}`;
  const result = executeHostFnDeploy({
    environment,
    workspace: root,
    env: { PATH: root, ARGS: args },
    executable,
  } as Parameters<typeof executeHostFnDeploy>[0]);
  expect(existsSync(sentinel)).toBe(false);
  expect(result.success).toBe(true);
  expect(JSON.parse(readFileSync(args, "utf8"))).toContain(environment);
});

import { executeHostFnDeployAsync } from "./steps/hostfn-deploy.js";
import { Runner } from "./runner.js";
import {
  MemoryStore,
  MemoryQueueClient,
  DEFAULT_QUEUE_NAME,
  type PipelineSpec,
} from "@cifn/control-plane";
import { MemoryLogFnClient } from "./reporting/logfn-client.js";
test("async argv preserves option-like environment literally and flags; job PATH does not choose executable", async () => {
  const { root, executable } = fixture(),
    args = join(root, "args");
  const result = await executeHostFnDeployAsync({
    environment: "--help",
    local: true,
    workspace: root,
    executable,
    env: { ARGS: args, PATH: "/not-a-host-path" },
  });
  expect(result.success).toBe(true);
  expect(JSON.parse(readFileSync(args, "utf8"))).toEqual([
    "deploy",
    "--local",
    "--ci",
    "--",
    "--help",
  ]);
});
test("managed Runner uses async host-owned executable, required CI flag and redacts streamed secrets", async () => {
  const { root, executable } = fixture(),
    args = join(root, "args");
  writeFileSync(
    executable,
    `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.ARGS,JSON.stringify(process.argv.slice(2)));process.stdout.write('token='+process.env.HOSTFN_SSH_KEY+'\\n');\n`,
  );
  const store = new MemoryStore(),
    queue = new MemoryQueueClient(),
    logs = new MemoryLogFnClient();
  const spec: PipelineSpec = {
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
    env: { ARGS: args, HOSTFN_SSH_KEY: "owned-secret-value" },
    secretKeys: ["HOSTFN_SSH_KEY"],
  });
  await runner.processNextJob();
  expect(store.getRun(run.id)?.status).toBe("success");
  expect(JSON.parse(readFileSync(args, "utf8"))).toEqual([
    "deploy",
    "--local",
    "--ci",
    "--",
    "production",
  ]);
  const output = JSON.stringify(logs.getAllLines(run.id));
  expect(output).not.toContain("owned-secret-value");
  expect(output).toContain("***");
});
test("active cancellation stops owned descendants and skips later always steps", async () => {
  const { root, executable } = fixture(),
    pidFile = join(root, "pid");
  writeFileSync(
    executable,
    `#!${process.execPath}\nconst cp=require('node:child_process'),fs=require('node:fs');process.on('SIGTERM',()=>{});const child=cp.spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});fs.writeFileSync(process.env.PID_FILE,String(child.pid));process.stdout.write('active\\n');setInterval(()=>{},1000);\n`,
  );
  const controller = new AbortController(),
    store = new MemoryStore(),
    queue = new MemoryQueueClient();
  class Logs extends MemoryLogFnClient {
    override appendLines(
      ...args: Parameters<MemoryLogFnClient["appendLines"]>
    ) {
      super.appendLines(...args);
      if (args[3].includes("active")) controller.abort();
    }
  }
  const spec: PipelineSpec = {
    on: { workflow_dispatch: {} },
    jobs: {
      deploy: {
        "runs-on": "default",
        steps: [
          { uses: "hostfn/deploy", with: { environment: "production" } },
          { run: "forbidden", if: "always()" },
        ],
      },
    },
  };
  const run = store.createRun({
    pipelineSpec: spec,
    trigger: { type: "workflow_dispatch" },
  });
  let later = 0;
  const runner = new Runner({
    store,
    queue,
    logClient: new Logs(),
    hostFnExecutable: executable,
    executionSignal: controller.signal,
    pipelineSpecs: new Map([[run.id, spec]]),
    runCommand: async () => {
      later++;
      return { exitCode: 0, stdout: "", stderr: "", lines: [] };
    },
  });
  await queue.enqueue(DEFAULT_QUEUE_NAME, {
    runId: run.id,
    jobKey: "deploy",
    jobSpec: spec.jobs.deploy,
    env: { PID_FILE: pidFile },
  });
  await runner.processNextJob();
  expect(later).toBe(0);
  expect(store.getRun(run.id)?.jobs[0].steps.map((s) => s.status)).toEqual([
    "failure",
    "skipped",
  ]);
  const pid = Number(readFileSync(pidFile, "utf8"));
  expect(() => process.kill(pid, 0)).toThrow();
});
test("deadline and logging failure are unsuccessful and owned process closes", async () => {
  const { root, executable } = fixture();
  writeFileSync(
    executable,
    `#!${process.execPath}\nprocess.stdout.write('active\\n');setInterval(()=>{},1000);\n`,
  );
  const timed = await executeHostFnDeployAsync({
    environment: "production",
    workspace: root,
    executable,
    timeoutMs: 100,
  });
  expect(timed.success).toBe(false);
  expect(timed.truncated).toBe(true);
  const failed = await executeHostFnDeployAsync({
    environment: "production",
    workspace: root,
    executable,
    onLines: (lines) => {
      if (lines.includes("active")) throw Error("secret callback");
    },
  });
  expect(failed.success).toBe(false);
  expect(JSON.stringify(failed)).not.toContain("secret callback");
});
test("public async helper redacts explicitly supplied env values and rejects invalid argv before launch", async () => {
  const { root, executable } = fixture(),
    args = join(root, "args");
  writeFileSync(
    executable,
    `#!${process.execPath}\nprocess.stdout.write(process.env.SECRET+'\\n');\n`,
  );
  const result = await executeHostFnDeployAsync({
    environment: "production",
    workspace: root,
    executable,
    env: { SECRET: "private-token" },
  });
  expect(result.success).toBe(true);
  expect(result.lines.join("\n")).not.toContain("private-token");
  expect(
    (
      await executeHostFnDeployAsync({
        environment: "bad\0value",
        workspace: root,
        executable,
        env: { ARGS: args },
      })
    ).success,
  ).toBe(false);
  expect(existsSync(args)).toBe(false);
});

test("async hostile argument stays literal and unavailable executable retains sanitized invocation context", async () => {
  const { root, executable } = fixture();
  const args = join(root, "args"),
    sentinel = join(root, "forbidden");
  const environment = `production; printf injected > ${sentinel}`;
  expect(
    (
      await executeHostFnDeployAsync({
        environment,
        workspace: root,
        executable,
        env: { ARGS: args },
      })
    ).success,
  ).toBe(true);
  expect(JSON.parse(readFileSync(args, "utf8")).at(-1)).toBe(environment);
  expect(existsSync(sentinel)).toBe(false);
  for (const deploy of [executeHostFnDeploy, executeHostFnDeployAsync]) {
    const result = await deploy({
      environment: "production",
      workspace: root,
      executable: "",
    });
    expect(result.success).toBe(false);
    expect(result.lines[0]).toContain("hostfn deploy production --ci");
  }
});
