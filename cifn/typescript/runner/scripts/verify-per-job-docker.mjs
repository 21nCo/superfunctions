/** Actual local Engine acceptance: requires an explicit context and cached POSIX image. */
import assert from "node:assert/strict";
import {
  mkdtemp,
  readdir,
  rm,
  mkdir,
  readFile,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  OwnedDockerExecutor,
  executeRemoteShellJob,
  MemoryLogFnClient,
} from "../dist/index.mjs";
const context = process.env.CIFN_DOCKER_CONTEXT,
  image = process.env.CIFN_DOCKER_IMAGE;
assert.ok(context && image, "Explicit cached image/context required");
const directory = await mkdtemp(join(tmpdir(), "cifn-perjob-native-")),
  stateDirectory = join(directory, "state");
let retain = false;
const crashState = join(directory, "crash-state");
const executor = new OwnedDockerExecutor({
  context,
  stateDirectory,
  timeoutMs: 10000,
});
async function run(steps, signal, logs = new MemoryLogFnClient(), env) {
  return executeRemoteShellJob(
    {
      runId: "owned-native",
      jobKey: "build",
      env,
      jobSpec: { "runs-on": "default", image, steps },
    },
    signal,
    logs,
    undefined,
    undefined,
    undefined,
    { ownedDockerExecutor: executor, executionOwner: "native-per-job" },
  );
}
try {
  const state = await run([
    {
      run: "printf retained > /tmp/cifn-owned-layer; printf workspace > /workspace/owned-file",
    },
    {
      run: 'test "$(cat /tmp/cifn-owned-layer)" = retained; test "$(cat /workspace/owned-file)" = workspace',
    },
  ]);
  assert.equal(state.status, "success");
  assert.deepEqual(await readdir(stateDirectory), []);
  const failure = await run([
    { run: "printf retained > /tmp/cifn-owned-layer; exit 7" },
    { if: "always()", run: 'test "$(cat /tmp/cifn-owned-layer)" = retained' },
  ]);
  assert.equal(failure.status, "failure");
  assert.deepEqual(
    failure.steps.map((step) => step.status),
    ["failure", "success"],
  );
  assert.deepEqual(await readdir(stateDirectory), []);
  const multiline = await run(
    [{ run: 'test "$(printf "%s" "$VALUE" | wc -l)" = 1' }],
    undefined,
    undefined,
    { VALUE: "first\nsecond" },
  );
  assert.equal(multiline.status, "success");
  assert.deepEqual(await readdir(stateDirectory), []);
  const controller = new AbortController();
  let observed = false;
  class Logs extends MemoryLogFnClient {
    appendLines(...args) {
      super.appendLines(...args);
      if (args[3].includes("owned-active")) {
        observed = true;
        controller.abort();
      }
    }
  }
  const cancelled = await run(
    [
      { run: 'printf "owned-active\\n"; sleep 30' },
      { if: "always()", run: "printf forbidden-later" },
    ],
    controller.signal,
    new Logs(),
  );
  assert.equal(observed, true);
  assert.equal(cancelled.status, "failure");
  assert.deepEqual(
    cancelled.steps.map((step) => step.status),
    ["failure", "skipped"],
  );
  assert.deepEqual(await readdir(stateDirectory), []);
  const crashWorkspace = join(directory, "crash-workspace");
  await mkdir(crashWorkspace);
  const modulePath = fileURLToPath(
    new URL("../dist/index.mjs", import.meta.url),
  );
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import {OwnedDockerExecutor} from ${JSON.stringify(modulePath)};const executor=new OwnedDockerExecutor(${JSON.stringify({ context, stateDirectory: crashState, timeoutMs: 60000 })});const session=await executor.openJob(${JSON.stringify({ image, workspace: crashWorkspace, owner: "native-killed-owner" })});await session.execute({command:'printf "owned-crash-active\\n"; sleep 60',onLines:lines=>{if(lines.includes('owned-crash-active'))process.stdout.write('ready\\n');}});await session.close();`,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "",
    cleanupCrash;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Owned child readiness deadline")),
        10000,
      );
      child.stdout.on("data", (chunk) => {
        output += chunk;
        if (output.includes("ready")) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.once("exit", () => {
        clearTimeout(timer);
        reject(new Error("Owned child exited before readiness"));
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    child.kill("SIGKILL");
    await Promise.race([
      exited,
      new Promise((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Owned child exit deadline")),
          3000,
        );
        timer.unref();
      }),
    ]);
    const entries = await readdir(crashState);
    assert.equal(entries.length, 1);
    const receipt = JSON.parse(
      await readFile(join(crashState, entries[0], "receipt.json"), "utf8"),
    );
    assert.equal(receipt.phase, "executing");
    assert.match(receipt.execId, /^[a-f0-9]{64}$/);
    assert.equal(receipt.owner, "native-killed-owner");
    assert.match(receipt.containerId, /^[a-f0-9]{64}$/);
    assert.match(receipt.id, /^[a-f0-9-]{36}$/);
    assert.equal(receipt.name, "cifn-" + receipt.id);
    assert.equal(receipt.context, context);
    const docker = (...args) =>
      execFileSync("docker", ["--context", context, ...args], {
        encoding: "utf8",
        timeout: 10000,
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    const inspect = () => {
      assert.equal(docker("info", "--format", "{{.ID}}"), receipt.daemonId);
      const value = JSON.parse(
        docker(
          "container",
          "inspect",
          "--format",
          '{"id":{{json .Id}},"owner":{{json (index .Config.Labels "io.21n.cifn.owner")}},"running":{{json .State.Running}},"execIds":{{json .ExecIDs}}}',
          receipt.containerId,
        ),
      );
      assert.equal(value.id, receipt.containerId);
      assert.equal(value.owner, receipt.id);
      return value;
    };
    cleanupCrash = async () => {
      inspect();
      docker("rm", "--force", receipt.containerId);
      assert.equal(
        docker(
          "container",
          "ls",
          "--all",
          "--filter",
          "id=" + receipt.containerId,
          "--format",
          "{{.ID}}",
        ),
        "",
      );
      assert.equal(
        docker(
          "container",
          "ls",
          "--all",
          "--filter",
          "name=^/" + receipt.name + "$",
          "--format",
          "{{.ID}}",
        ),
        "",
      );
      await rm(crashState, { recursive: true });
      cleanupCrash = undefined;
    };
    const state = inspect();
    assert.equal(state.running, true);
    assert.ok(state.execIds.includes(receipt.execId));
    // Trusted host adjudication is distinct from knowing the original shell result.
    const operator = new OwnedDockerExecutor({
      context,
      stateDirectory: crashState,
    });
    const snapshot = operator.inspectReceipt(receipt.id);
    assert.equal(snapshot.execId, receipt.execId);
    const decision = {
      id: receipt.id,
      fingerprint: snapshot.fingerprint,
      owner: snapshot.owner,
      operatorId: "native-operator",
      stoppedOwner: true,
    };
    const lockOwner = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import {OwnedDockerExecutor} from ${JSON.stringify(modulePath)};const keep=setInterval(()=>{},1000);const operator=new OwnedDockerExecutor(${JSON.stringify({ context, stateDirectory: crashState })},async()=>{process.stdout.write('locked');return new Promise(()=>{});});await operator.cleanupReceipt(${JSON.stringify(decision)});clearInterval(keep);`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const lockExit = new Promise((resolve) => lockOwner.once("exit", resolve));
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(Error("Operator lock deadline")),
          5000,
        );
        lockOwner.stdout.once("data", () => {
          clearTimeout(timer);
          resolve();
        });
        lockOwner.once("error", reject);
        lockOwner.once("exit", () => {
          clearTimeout(timer);
          reject(Error("Operator exited before lock"));
        });
      });
      await assert.rejects(operator.cleanupReceipt(decision), /EEXIST/);
    } finally {
      lockOwner.kill("SIGKILL");
      await Promise.race([
        lockExit,
        new Promise((_, reject) => {
          const timer = setTimeout(
            () => reject(Error("Operator exit deadline")),
            3000,
          );
          timer.unref();
        }),
      ]);
    }
    await assert.rejects(operator.cleanupReceipt(decision), /EEXIST/);
    // Explicit fixture-only offline repair after this exact lock owner's exit, never stale-lock stealing in the API.
    await unlink(join(crashState, receipt.id, "cleanup.lock"));
    const cleaned = await operator.cleanupReceipt(decision);
    assert.equal(cleaned.containerRemoved, true);
    assert.equal(cleaned.executionOutcome, "unknown");
    assert.deepEqual(
      await new OwnedDockerExecutor({
        context,
        stateDirectory: crashState,
      }).cleanupReceipt(decision),
      cleaned,
    );
    cleanupCrash = undefined;
    await rm(crashState, { recursive: true });
  } catch (error) {
    retain = true;
    throw error;
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await Promise.race([
        exited,
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
      if (child.exitCode === null && child.signalCode === null) retain = true;
    }
    if (cleanupCrash && (child.exitCode !== null || child.signalCode !== null))
      await cleanupCrash();
  }
  console.log(
    JSON.stringify({
      passed: true,
      nativeDocker: true,
      perJobFilesystem: true,
      knownFailureAlwaysStep: true,
      multilineEnvironment: true,
      activeCancellationNoLaterStep: true,
      killedOwnerReceipt: true,
      liveExecIdentityAfterReopen: true,
      fixtureOnlyOperatorCleanup: true,
      publicReceiptCleanup: true,
      independentOperatorLock: true,
      killedOperatorLockRetained: true,
      ownedContainersRemoved: true,
      context,
      image,
    }),
  );
} finally {
  const receipts = await readdir(stateDirectory).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const crashReceipts = await readdir(crashState).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  if (!retain && receipts.length === 0 && crashReceipts.length === 0)
    await rm(directory, { recursive: true, force: true });
  else console.error("Container fixture evidence retained:", directory);
}
