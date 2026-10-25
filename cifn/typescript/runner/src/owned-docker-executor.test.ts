import { afterEach, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OwnedDockerExecutor,
  type DockerCommand,
} from "./owned-docker-executor.js";
import { ProcessGroupUncertainError } from "./executor/owned-shell.js";
import { executeRemoteShellJob } from "./remote-runner.js";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture(mode = "success") {
  const root = mkdtempSync(join(tmpdir(), "cifn-docker-unit-"));
  roots.push(root);
  const workspace = join(root, "workspace"),
    stateDirectory = join(root, "state");
  mkdirSync(workspace);
  const calls: string[][] = [];
  let lastWorkspace = "";
  let id = "",
    name = "",
    started = false,
    removed = false;
  const cid = "a".repeat(64);
  const command: DockerCommand = async (
    args,
    _cwd,
    _signal,
    onLines,
    _timeout,
    internalEnv,
  ) => {
    calls.push(args);
    lastWorkspace = _cwd;
    const ok = (stdout = "") => ({
      exitCode: 0,
      stdout,
      stderr: "",
      lines: [] as string[],
    });
    if (args[0] === "info") return ok("daemon-owned");
    if (args[0] === "create") {
      name = args[args.indexOf("--name") + 1];
      id = name.slice(5);
      const file = args[args.indexOf("--env-file") + 1];
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(
        JSON.parse(
          readFileSync(join(stateDirectory, id, "receipt.json"), "utf8"),
        ).owner,
      ).toBeTruthy();
      expect(args.join(" ")).not.toContain("private-value");
      expect(internalEnv?.CIFN_INTERNAL_COMMAND).toBeTruthy();
      if (mode === "create-unknown") throw new Error("transport lost");
      return ok(cid);
    }
    if (args[0] === "start") {
      started = true;
      onLines?.(["container output"]);
      return {
        ...ok("container output"),
        exitCode: mode === "nonzero" ? 7 : 0,
        ...(mode === "timeout" ? { truncated: true } : {}),
      };
    }
    if (args[0] === "container" && args[1] === "inspect")
      return ok(
        JSON.stringify({
          id: cid,
          owner: mode === "foreign" ? "foreign" : id,
          running: mode === "timeout" && started,
          status: started ? "exited" : "created",
          exitCode: mode === "nonzero" ? 7 : 0,
        }),
      );
    if (args[0] === "rm") {
      if (mode === "cleanup-failure")
        return { exitCode: 1, stdout: "", stderr: "unavailable", lines: [] };
      removed = true;
      return ok(cid);
    }
    if (args[0] === "container" && args[1] === "ls")
      return ok(removed ? "" : cid);
    throw new Error("unexpected command");
  };
  return {
    workspace,
    stateDirectory,
    calls,
    get lastWorkspace() {
      return lastWorkspace;
    },
    executor: new OwnedDockerExecutor(
      { context: "owned", stateDirectory },
      command,
    ),
  };
}
it("persists private ownership before create, excludes secrets from argv and verifies removal", async () => {
  const f = fixture();
  const lines: string[] = [];
  const result = await f.executor.execute({
    image: "owned:cached",
    workspace: f.workspace,
    command: "printf private-value",
    env: { SECRET: "private-value" },
    owner: "exact-execution",
    onLines: (value) => lines.push(...value),
  });
  expect(result.exitCode).toBe(0);
  expect(lines).toEqual(["container output"]);
  expect(readdirSync(f.stateDirectory)).toEqual([]);
  expect(f.calls.some((args) => args[0] === "rm")).toBe(true);
});
it("preserves nonzero exit and cancels timed out containers before releasing ownership", async () => {
  for (const mode of ["nonzero", "timeout"]) {
    const f = fixture(mode);
    const result = await f.executor.execute({
      image: "owned:cached",
      workspace: f.workspace,
      command: "exit 7",
      owner: "exact",
    });
    expect(result.exitCode).toBe(mode === "nonzero" ? 7 : 1);
    expect(readdirSync(f.stateDirectory)).toEqual([]);
  }
});
it("retains uncertain creation and cleanup receipts and never removes foreign ownership", async () => {
  for (const mode of ["create-unknown", "cleanup-failure", "foreign"]) {
    const f = fixture(mode);
    await expect(
      f.executor.execute({
        image: "owned:cached",
        workspace: f.workspace,
        command: "true",
        owner: "exact",
      }),
    ).rejects.toBeInstanceOf(ProcessGroupUncertainError);
    expect(readdirSync(f.stateDirectory)).toHaveLength(1);
    if (mode === "foreign")
      expect(f.calls.some((args) => args[0] === "rm")).toBe(false);
  }
});
it("rejects malformed environment before any Docker operation", async () => {
  const f = fixture();
  await expect(
    f.executor.execute({
      image: "owned:cached",
      workspace: f.workspace,
      command: "true",
      env: { SECRET: "two\nlines" },
      owner: "exact",
    }),
  ).rejects.toThrow("single-line");
  expect(f.calls).toEqual([]);
});
it("routes remote image jobs through the owned async executor", async () => {
  const f = fixture();
  const result = await executeRemoteShellJob(
    {
      runId: "run",
      jobKey: "build",
      jobSpec: {
        "runs-on": "default",
        image: "owned:cached",
        steps: [{ run: "true" }],
      },
    },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { ownedDockerExecutor: f.executor, executionOwner: "remote-exact" },
  );
  expect(result.status).toBe("success");
  expect(f.calls.some((args) => args[0] === "start")).toBe(true);
  expect(readdirSync(f.stateDirectory)).toEqual([]);
});

it("retains the real remote workspace when daemon cleanup cannot be confirmed", async () => {
  const f = fixture("cleanup-failure");
  try {
    await expect(
      executeRemoteShellJob(
        {
          runId: "run",
          jobKey: "build",
          jobSpec: {
            "runs-on": "default",
            image: "owned:cached",
            steps: [{ run: "true" }],
          },
        },
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { ownedDockerExecutor: f.executor, executionOwner: "remote-exact" },
      ),
    ).rejects.toBeInstanceOf(ProcessGroupUncertainError);
    expect(existsSync(f.lastWorkspace)).toBe(true);
    expect(readdirSync(f.stateDirectory)).toHaveLength(1);
  } finally {
    if (f.lastWorkspace && f.lastWorkspace !== f.workspace)
      rmSync(f.lastWorkspace, { recursive: true, force: true });
  }
});
it("settles cleanup before surfacing output persistence failure", async () => {
  const f = fixture();
  await expect(
    f.executor.execute({
      image: "owned:cached",
      workspace: f.workspace,
      command: "true",
      owner: "exact",
      onLines: () => {
        throw new Error("secret sink failure");
      },
    }),
  ).rejects.toThrow("Container output could not be persisted");
  expect(readdirSync(f.stateDirectory)).toEqual([]);
});
it("does no Docker work for an already cancelled operation", async () => {
  const f = fixture(),
    controller = new AbortController();
  controller.abort();
  const result = await f.executor.execute({
    image: "owned:cached",
    workspace: f.workspace,
    command: "true",
    owner: "exact",
    signal: controller.signal,
  });
  expect(result.exitCode).toBe(1);
  expect(f.calls).toEqual([]);
});

it("cleans an in-flight externally cancelled container before returning", async () => {
  const f = fixture(),
    controller = new AbortController();
  const result = await f.executor.execute({
    image: "owned:cached",
    workspace: f.workspace,
    command: "true",
    owner: "exact",
    signal: controller.signal,
    onLines: () => controller.abort(),
  });
  expect(result.exitCode).toBe(1);
  expect(f.calls.some((args) => args[0] === "rm")).toBe(true);
  expect(readdirSync(f.stateDirectory)).toEqual([]);
});
it("marks remote container output truncation in the durable log callback", async () => {
  const f = fixture("timeout");
  let truncated = 0;
  const result = await executeRemoteShellJob(
    {
      runId: "run",
      jobKey: "build",
      jobSpec: {
        "runs-on": "default",
        image: "owned:cached",
        steps: [{ run: "true" }],
      },
    },
    undefined,
    undefined,
    () => {
      truncated += 1;
    },
    undefined,
    undefined,
    { ownedDockerExecutor: f.executor, executionOwner: "remote-exact" },
  );
  expect(result.status).toBe("failure");
  expect(truncated).toBe(1);
});

it("rejects private state inside the mounted workspace before any secret or Docker admission", async () => {
  const f = fixture();
  const stateDirectory = join(f.workspace, "private-state");
  let calls = 0;
  const executor = new OwnedDockerExecutor(
    { context: "fixture", stateDirectory },
    async () => {
      calls++;
      throw new Error("must not call");
    },
  );
  await expect(
    executor.execute({
      image: "owned:cached",
      workspace: f.workspace,
      command: "true",
      env: { SECRET: "private-value" },
      owner: "exact",
    }),
  ).rejects.toThrow("outside the workspace");
  expect(calls).toBe(0);
  expect(readdirSync(stateDirectory)).toEqual([]);
});
