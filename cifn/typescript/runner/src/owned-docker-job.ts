import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  realpathSync,
  lstatSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { DockerEngineError, type DockerEngine } from "./docker-engine.js";
import { ProcessGroupUncertainError } from "./executor/owned-shell.js";
import type { RunStepResult } from "./executor/run-step.js";
export interface DockerJobOptions {
  image: string;
  workspace: string;
  owner: string;
  signal?: AbortSignal;
}
export interface DockerJobStep {
  command: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
  onLines?: (lines: string[]) => void;
}
export interface OwnedDockerJob {
  execute(step: DockerJobStep): Promise<RunStepResult>;
  close(): Promise<void>;
}
/** The container was removed, but this command cannot be reported as successfully completed. */
export class DockerExecutionInterruptedError extends Error {
  constructor(readonly outputIncomplete = true) {
    super("Container execution interrupted; owned container removed");
  }
}
const label = "io.21n.cifn.owner";
const validId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function syncDirectory(path: string) {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
interface Receipt {
  version: 2;
  mode: "job";
  owner: string;
  id: string;
  name: string;
  context: string;
  daemonId: string;
  workspace: string;
  image: string;
  containerId: string;
  execId: string;
  phase: string;
  lastExecId?: string;
  lastExitCode?: number;
}
export async function openOwnedDockerJob(
  engine: DockerEngine,
  directory: string,
  context: string,
  daemonId: string,
  timeoutMs: number,
  job: DockerJobOptions,
): Promise<OwnedDockerJob> {
  if (
    typeof job.image !== "string" ||
    !job.image ||
    job.image.startsWith("-") ||
    /[\x00-\x20\x7f]/.test(job.image) ||
    job.image.length > 512 ||
    typeof job.owner !== "string" ||
    !job.owner ||
    job.owner.length > 1024
  )
    throw new Error("Invalid owned Docker job");
  const workspace = realpathSync(job.workspace),
    relation = relative(workspace, directory);
  if (
    !lstatSync(workspace).isDirectory() ||
    relation === "" ||
    (!isAbsolute(relation) &&
      relation !== ".." &&
      !relation.startsWith(`..${sep}`))
  )
    throw new Error(
      "Docker state directory must be outside the workspace mount",
    );
  if (job.signal?.aborted) throw new DockerExecutionInterruptedError(false);
  const info = (await engine.json("GET", "/info")) as { ID?: unknown };
  if (info?.ID !== daemonId) throw new ProcessGroupUncertainError();
  const id = randomUUID(),
    name = `cifn-${id}`,
    owned = join(directory, id);
  mkdirSync(owned, { mode: 0o700 });
  syncDirectory(directory);
  const receipt: Receipt = {
    version: 2,
    mode: "job",
    owner: job.owner,
    id,
    name,
    context,
    daemonId,
    workspace,
    image: job.image,
    containerId: "",
    execId: "",
    phase: "creating",
  };
  const save = () => {
    const path = join(owned, "receipt.tmp"),
      fd = openSync(path, "w", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(receipt));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(path, join(owned, "receipt.json"));
    syncDirectory(owned);
  };
  try {
    save();
  } catch (error) {
    rmSync(owned, { recursive: true });
    syncDirectory(directory);
    throw error;
  }
  let creationAttempted = false;
  const session = new DockerJobSession(
    engine,
    directory,
    owned,
    receipt,
    save,
    timeoutMs,
  );
  try {
    creationAttempted = true;
    const created = (await engine.json(
      "POST",
      `/containers/create?name=${encodeURIComponent(name)}`,
      {
        Image: job.image,
        Entrypoint: ["/bin/sh"],
        Cmd: ["-c", 'trap "exit 0" TERM INT; while :; do sleep 60; done'],
        WorkingDir: "/workspace",
        Labels: { [label]: id },
        HostConfig: {
          Mounts: [{ Type: "bind", Source: workspace, Target: "/workspace" }],
        },
      },
      job.signal,
    )) as { Id?: unknown };
    if (!validId(created?.Id)) throw new ProcessGroupUncertainError();
    receipt.containerId = created.Id;
    receipt.phase = "created";
    save();
    await session.verify(false);
    await engine.json(
      "POST",
      `/containers/${receipt.containerId}/start`,
      undefined,
      job.signal,
    );
    await session.verify(true);
    receipt.phase = "ready";
    save();
    return session;
  } catch (error) {
    if (receipt.containerId) {
      await session.close();
      throw new DockerExecutionInterruptedError(false);
    }
    if (!creationAttempted) {
      rmSync(owned, { recursive: true });
      syncDirectory(directory);
      throw error;
    }
    // An unanswered create can finish later; do not infer absence from an immediate lookup.
    throw new ProcessGroupUncertainError();
  }
}
class DockerJobSession implements OwnedDockerJob {
  private active?: Promise<RunStepResult>;
  private controller?: AbortController;
  private closed = false;
  private removal?: Promise<void>;
  constructor(
    private engine: DockerEngine,
    private directory: string,
    private owned: string,
    private receipt: Receipt,
    private save: () => void,
    private timeout: number,
  ) {}
  async verify(running: boolean) {
    const info = (await this.engine.json("GET", "/info")) as { ID?: unknown };
    if (info?.ID !== this.receipt.daemonId)
      throw new ProcessGroupUncertainError();
    const state = (await this.engine.json(
      "GET",
      `/containers/${this.receipt.containerId}/json`,
    )) as {
      Id?: unknown;
      Config?: { Labels?: Record<string, unknown> };
      State?: { Running?: unknown };
    };
    if (
      state?.Id !== this.receipt.containerId ||
      state.Config?.Labels?.[label] !== this.receipt.id ||
      (running && state.State?.Running !== true)
    )
      throw new ProcessGroupUncertainError();
  }
  execute(step: DockerJobStep): Promise<RunStepResult> {
    if (this.closed || this.active)
      return Promise.reject(
        new Error("Docker job is closed or already executing"),
      );
    const task = this.run(step);
    this.active = task;
    return task.finally(() => {
      if (this.active === task) this.active = undefined;
    });
  }
  private async run(step: DockerJobStep): Promise<RunStepResult> {
    if (
      typeof step.command !== "string" ||
      step.command.includes("\0") ||
      Buffer.byteLength(step.command) > 262144
    )
      throw new Error("Invalid Docker command");
    const variables = Object.entries(step.env ?? {});
    if (
      variables.length > 256 ||
      variables.some(
        ([key, value]) =>
          key === "CIFN_INTERNAL_COMMAND" ||
          !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ||
          typeof value !== "string" ||
          value.includes("\0"),
      )
    )
      throw new Error("Invalid Docker environment");
    const env = variables.map(([key, value]) => `${key}=${value}`);
    if (Buffer.byteLength(JSON.stringify(env)) > 262144)
      throw new Error("Docker environment exceeds limit");
    const controller = new AbortController();
    this.controller = controller;
    const abort = () => controller.abort();
    step.signal?.addEventListener("abort", abort, { once: true });
    if (step.signal?.aborted) abort();
    let startAttempted = false;
    try {
      if (controller.signal.aborted) throw new DockerEngineError();
      await this.verify(true);
      const created = (await this.engine.json(
        "POST",
        `/containers/${this.receipt.containerId}/exec`,
        {
          AttachStdout: true,
          AttachStderr: true,
          Tty: false,
          WorkingDir: "/workspace",
          Env: [...env, `CIFN_INTERNAL_COMMAND=${step.command}`],
          Cmd: [
            "/bin/sh",
            "-c",
            'command=$CIFN_INTERNAL_COMMAND; unset CIFN_INTERNAL_COMMAND; eval "$command"',
          ],
        },
        controller.signal,
      )) as { Id?: unknown };
      if (!validId(created?.Id)) throw new DockerEngineError();
      this.receipt.execId = created.Id;
      this.receipt.phase = "executing";
      this.save();
      startAttempted = true;
      const output = await this.engine.attach(
        `/exec/${created.Id}/start`,
        { Detach: false, Tty: false },
        controller.signal,
        this.timeout,
        step.onLines,
      );
      if (controller.signal.aborted) throw new DockerEngineError();
      const final = (await this.engine.json(
        "GET",
        `/exec/${created.Id}/json`,
      )) as {
        ID?: unknown;
        ContainerID?: unknown;
        Running?: unknown;
        ExitCode?: unknown;
      };
      if (
        final?.ID !== created.Id ||
        final.ContainerID !== this.receipt.containerId ||
        final.Running !== false ||
        !Number.isInteger(final.ExitCode)
      )
        throw new DockerEngineError();
      await this.verify(true);
      this.receipt.lastExecId = created.Id;
      this.receipt.lastExitCode = final.ExitCode as number;
      this.receipt.execId = "";
      this.receipt.phase = "ready";
      this.save();
      return { ...output, exitCode: final.ExitCode as number };
    } catch {
      // A lost attach/inspect result may leave execution alive. Remove the entire owned
      // container and stop admission; only a verified removal permits a failed outcome.
      await this.remove();
      throw new DockerExecutionInterruptedError(startAttempted);
    } finally {
      step.signal?.removeEventListener("abort", abort);
      if (this.controller === controller) this.controller = undefined;
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    this.controller?.abort();
    await this.active?.catch(() => {});
    await this.remove();
  }
  private remove(): Promise<void> {
    this.closed = true;
    if (this.removal) return this.removal;
    const task = (async () => {
      try {
        this.receipt.phase = "closing";
        this.save();
        await this.verify(false);
        await this.engine.json(
          "DELETE",
          `/containers/${this.receipt.containerId}?force=1`,
        );
        for (const identity of [this.receipt.containerId, this.receipt.name]) {
          try {
            await this.engine.json("GET", `/containers/${identity}/json`);
            throw new ProcessGroupUncertainError();
          } catch (error) {
            if (!(error instanceof DockerEngineError && error.status === 404))
              throw error;
          }
        }
        rmSync(this.owned, { recursive: true });
        syncDirectory(this.directory);
      } catch {
        try {
          this.receipt.phase = "cleanup-uncertain";
          this.save();
        } catch {}
        throw new ProcessGroupUncertainError();
      }
    })();
    this.removal = task;
    void task.catch(() => {});
    return task;
  }
}
