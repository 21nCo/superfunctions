import { afterEach, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  openOwnedDockerJob,
  DockerExecutionInterruptedError,
} from "./owned-docker-job.js";
import { ProcessGroupUncertainError } from "./executor/owned-shell.js";
import { fakeDockerEngine } from "./__tests__/fake-docker-engine.js";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
async function fixture(mode = "success") {
  const root = mkdtempSync(join(tmpdir(), "cifn-job-test-"));
  roots.push(root);
  const workspace = join(root, "workspace"),
    state = join(root, "state");
  mkdirSync(workspace);
  mkdirSync(state, { mode: 0o700 });
  const engine = fakeDockerEngine(mode);
  const session = await openOwnedDockerJob(
    engine,
    state,
    "fixture",
    "daemon-owned",
    5000,
    { image: "cached", workspace, owner: "exact" },
  );
  return { session, engine, state };
}
it("retains one container across known zero/nonzero commands and records each exec before start", async () => {
  const f = await fixture();
  const original = f.engine.attach;
  f.engine.attach = async (...args) => {
    const [directory] = readdirSync(f.state);
    const receipt = JSON.parse(
      readFileSync(join(f.state, directory, "receipt.json"), "utf8"),
    );
    expect(receipt.execId).toHaveLength(64);
    expect(receipt.phase).toBe("executing");
    return original(...args);
  };
  expect(
    (
      await f.session.execute({
        command: "write-state",
        env: { MULTILINE: "line1\nline2" },
      })
    ).exitCode,
  ).toBe(0);
  expect((await f.session.execute({ command: "exit 7" })).exitCode).toBe(7);
  expect((await f.session.execute({ command: "read-state" })).exitCode).toBe(0);
  expect(f.engine.created).toBe(1);
  expect(f.engine.deleted).toBe(0);
  await f.session.close();
  await f.session.close();
  expect(f.engine.deleted).toBe(1);
  expect(readdirSync(f.state)).toEqual([]);
});
it("parks uncertain cleanup with exec identity and never admits another step", async () => {
  const f = await fixture("cleanup-failure");
  await f.session.execute({ command: "true" });
  await expect(f.session.close()).rejects.toBeInstanceOf(
    ProcessGroupUncertainError,
  );
  await expect(f.session.execute({ command: "later" })).rejects.toThrow(
    "closed",
  );
  const receipt = JSON.parse(
    readFileSync(
      join(f.state, readdirSync(f.state)[0], "receipt.json"),
      "utf8",
    ),
  );
  expect(receipt.phase).toBe("cleanup-uncertain");
  expect(receipt.lastExecId).toHaveLength(64);
});
it("removes the container after unknown execution and prevents later always-step admission", async () => {
  const f = await fixture("timeout");
  await expect(
    f.session.execute({ command: "uncertain" }),
  ).rejects.toBeInstanceOf(DockerExecutionInterruptedError);
  expect(f.engine.deleted).toBe(1);
  expect(readdirSync(f.state)).toEqual([]);
  await expect(f.session.execute({ command: "later" })).rejects.toThrow(
    "closed",
  );
  await f.session.close();
});
it("serializes command admission and joins active cancellation on close", async () => {
  const f = await fixture();
  let release!: () => void;
  f.engine.hold = () =>
    new Promise<void>((resolve) => {
      release = resolve;
    });
  const pending = f.session.execute({ command: "held" });
  const observed = pending.catch((error) => error);
  while (!release) await new Promise((resolve) => setTimeout(resolve, 0));
  await expect(f.session.execute({ command: "overlap" })).rejects.toThrow(
    "already executing",
  );
  const closing = f.session.close();
  release();
  expect(await observed).toBeInstanceOf(DockerExecutionInterruptedError);
  await closing;
  expect(f.engine.deleted).toBe(1);
  expect(readdirSync(f.state)).toEqual([]);
});

it("does not continue an always-step after an ambiguous transport result", async () => {
  const root = mkdtempSync(join(tmpdir(), "cifn-job-remote-"));
  roots.push(root);
  const engine = fakeDockerEngine("timeout");
  const { OwnedDockerExecutor } = await import("./owned-docker-executor.js");
  const { executeRemoteShellJob } = await import("./remote-runner.js");
  const executor = new OwnedDockerExecutor(
    { stateDirectory: join(root, "state"), context: "fixture" },
    async (args) => ({
      exitCode: 0,
      stdout:
        args[0] === "context"
          ? JSON.stringify("unix:///fixture")
          : "daemon-owned",
      stderr: "",
      lines: [],
    }),
    () => engine,
  );
  const result = await executeRemoteShellJob(
    {
      runId: "run",
      jobKey: "job",
      jobSpec: {
        "runs-on": "default",
        image: "fixture",
        steps: [{ run: "uncertain" }, { if: "always()", run: "must not run" }],
      },
    },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { ownedDockerExecutor: executor, executionOwner: "exact" },
  );
  expect(result.status).toBe("failure");
  expect(result.steps.map((step) => step.status)).toEqual([
    "failure",
    "skipped",
  ]);
  expect(engine.commands).toEqual(["uncertain"]);
  expect(engine.deleted).toBe(1);
});
