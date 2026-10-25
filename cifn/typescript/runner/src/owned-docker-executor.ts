import {
  inspectDockerReceipt,
  cleanupDockerReceipt,
  type DockerReceiptDecision,
} from "./docker-receipts.js";
import { UnixDockerEngine, type DockerEngine } from "./docker-engine.js";
import {
  DockerExecutionInterruptedError,
  openOwnedDockerJob,
  type DockerJobOptions,
  type OwnedDockerJob,
} from "./owned-docker-job.js";
import {
  constants,
  accessSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { delimiter, isAbsolute, join, relative, sep } from "node:path";
import { randomUUID } from "node:crypto";
import {
  executeOwnedProcess,
  ProcessGroupUncertainError,
} from "./executor/owned-shell.js";
import type { RunStepResult } from "./executor/run-step.js";
export interface OwnedDockerOptions {
  stateDirectory: string;
  context: string;
  executable?: string;
  timeoutMs?: number;
}
export interface OwnedDockerStep {
  image: string;
  workspace: string;
  command: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
  onLines?: (lines: string[]) => void;
  owner: string;
}
export type DockerCommand = (
  args: string[],
  cwd: string,
  signal?: AbortSignal,
  onLines?: (lines: string[]) => void,
  timeoutMs?: number,
  internalEnv?: Record<string, string>,
) => Promise<RunStepResult>;
const label = "io.21n.cifn.owner";
function executablePath(value?: string) {
  if (value) {
    if (!isAbsolute(value))
      throw new Error("Docker executable must be absolute");
    return realpathSync(value);
  }
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    try {
      const file = join(directory, "docker");
      accessSync(file, constants.X_OK);
      return realpathSync(file);
    } catch {
      /* next trusted PATH entry */
    }
  }
  throw new Error("Docker executable unavailable");
}
function syncDirectory(directory: string) {
  const fd = openSync(directory, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
/** Actual asynchronous CLI transport. Custom transport injection is host-owned test/integration configuration. */
export class OwnedDockerExecutor {
  private readonly directory: string;
  private readonly command: DockerCommand;
  private readonly timeout: number;
  private readonly context: string;
  constructor(
    options: OwnedDockerOptions,
    command?: DockerCommand,
    private readonly engineFactory: (socketPath: string) => DockerEngine = (
      socketPath,
    ) => new UnixDockerEngine(socketPath),
  ) {
    if (
      !options.context ||
      options.context.length > 128 ||
      !/^[A-Za-z0-9_.-]+$/.test(options.context) ||
      options.context.startsWith("-")
    )
      throw new Error("Explicit Docker context required");
    this.context = options.context;
    this.timeout = options.timeoutMs ?? 300_000;
    if (
      !Number.isSafeInteger(this.timeout) ||
      this.timeout < 1 ||
      this.timeout > 3_600_000
    )
      throw new Error("Invalid Docker timeout");
    mkdirSync(options.stateDirectory, { recursive: true, mode: 0o700 });
    if (lstatSync(options.stateDirectory).isSymbolicLink())
      throw new Error("Docker state directory cannot be a symlink");
    this.directory = realpathSync(options.stateDirectory);
    if ((lstatSync(this.directory).mode & 0o077) !== 0)
      throw new Error("Docker state directory must be private");
    const executable = command ? undefined : executablePath(options.executable);
    const cliEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      LANG: "C",
      DOCKER_CONTEXT: options.context,
    };
    this.command =
      command ??
      ((args, cwd, signal, onLines, timeoutMs, internalEnv) =>
        executeOwnedProcess(
          executable!,
          ["--context", this.context, ...args],
          cwd,
          { ...cliEnv, ...internalEnv },
          signal,
          onLines,
          timeoutMs,
        ));
  }
  inspectReceipt(id: string) {
    return inspectDockerReceipt(this.directory, this.context, id);
  }
  cleanupReceipt(decision: DockerReceiptDecision) {
    return cleanupDockerReceipt(this.directory, this.context, decision, () =>
      this.connectEngine(),
    );
  }
  private async connectEngine(
    signal?: AbortSignal,
    workspace = this.directory,
  ): Promise<{
    engine: DockerEngine;
    daemonId: string;
  }> {
    const context = await this.command(
      [
        "context",
        "inspect",
        this.context,
        "--format",
        "{{json .Endpoints.docker.Host}}",
      ],
      workspace,
      signal,
      undefined,
      5000,
    );
    let endpoint: unknown;
    try {
      endpoint = JSON.parse(context.stdout);
    } catch {
      throw new Error("Docker context endpoint unavailable");
    }
    if (
      context.exitCode !== 0 ||
      context.truncated ||
      typeof endpoint !== "string" ||
      !endpoint.startsWith("unix://") ||
      !isAbsolute(endpoint.slice(7)) ||
      /[\0\r\n]/.test(endpoint)
    )
      throw new Error(
        "Owned job containers require a local Unix Docker context",
      );
    const info = await this.command(
      ["info", "--format", "{{.ID}}"],
      workspace,
      signal,
      undefined,
      5000,
    );
    if (info.exitCode !== 0 || info.truncated || !info.stdout.trim())
      throw new Error("Docker daemon unavailable");
    return {
      engine: this.engineFactory(endpoint.slice(7)),
      daemonId: info.stdout.trim(),
    };
  }
  async openJob(job: DockerJobOptions): Promise<OwnedDockerJob> {
    try {
      const { engine, daemonId } = await this.connectEngine(
        job.signal,
        job.workspace,
      );
      return await openOwnedDockerJob(
        engine,
        this.directory,
        this.context,
        daemonId,
        this.timeout,
        job,
      );
    } catch (error) {
      if (
        error instanceof ProcessGroupUncertainError ||
        error instanceof DockerExecutionInterruptedError
      )
        throw error;
      throw new DockerExecutionInterruptedError(false);
    }
  }
  async execute(step: OwnedDockerStep): Promise<RunStepResult> {
    if (
      !step.image ||
      step.image.startsWith("-") ||
      /[\x00-\x20\x7f]/.test(step.image) ||
      step.image.length > 512 ||
      typeof step.owner !== "string" ||
      !step.owner ||
      step.owner.length > 1024
    )
      throw new Error("Invalid owned Docker step");
    if (
      typeof step.command !== "string" ||
      Buffer.byteLength(step.command) > 262144 ||
      step.command.includes("\0")
    )
      throw new Error("Invalid Docker command");
    if (step.signal?.aborted)
      return { exitCode: 1, stdout: "", stderr: "", lines: [] };
    const workspace = realpathSync(step.workspace);
    if (
      !lstatSync(workspace).isDirectory() ||
      workspace.includes(",") ||
      workspace.includes("\n")
    )
      throw new Error("Unsupported Docker workspace path");
    const stateInWorkspace = relative(workspace, this.directory);
    if (
      stateInWorkspace === "" ||
      (!isAbsolute(stateInWorkspace) &&
        stateInWorkspace !== ".." &&
        !stateInWorkspace.startsWith(`..${sep}`))
    ) {
      throw new Error(
        "Docker state directory must be outside the workspace mount",
      );
    }
    const variables = Object.entries(step.env ?? {});
    if (
      variables.length > 256 ||
      variables.some(
        ([key, value]) =>
          key === "CIFN_INTERNAL_COMMAND" ||
          !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ||
          typeof value !== "string" ||
          /[\r\n\0]/.test(value),
      )
    )
      throw new Error("Docker env-file requires single-line named values");
    const env = variables
      .map(([key, value]) => `${key}=${value}`)
      .concat("CIFN_INTERNAL_COMMAND")
      .join("\n");
    if (Buffer.byteLength(env) > 262144)
      throw new Error("Docker environment exceeds limit");
    const daemon = await this.command(
      ["info", "--format", "{{.ID}}"],
      workspace,
      step.signal,
      undefined,
      5000,
    );
    if (daemon.exitCode !== 0 || daemon.truncated || !daemon.stdout.trim())
      throw new Error("Docker daemon unavailable");
    const daemonId = daemon.stdout.trim(),
      id = randomUUID(),
      name = `cifn-${id}`;
    const owned = join(this.directory, id);
    mkdirSync(owned, { mode: 0o700 });
    syncDirectory(this.directory);
    const envPath = join(owned, "environment"),
      receiptPath = join(owned, "receipt.json");
    const receipt = {
      version: 1,
      owner: step.owner,
      name,
      id,
      context: this.context,
      daemonId,
      workspace,
      image: step.image,
      containerId: "",
    };
    const save = () => {
      const temp = join(owned, "receipt.tmp");
      const fd = openSync(temp, "w", 0o600);
      try {
        writeFileSync(fd, JSON.stringify(receipt));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temp, receiptPath);
      syncDirectory(owned);
    };
    let created = false,
      cliUncertain = false,
      createAttempted = false;
    const uncertain = () => new ProcessGroupUncertainError();
    const inspect = async () => {
      const format = `{"id":{{json .Id}},"owner":{{json (index .Config.Labels "${label}")}},"running":{{json .State.Running}},"status":{{json .State.Status}},"exitCode":{{json .State.ExitCode}}}`;
      const result = await this.command(
        ["container", "inspect", "--format", format, name],
        workspace,
        undefined,
        undefined,
        10000,
      );
      if (result.exitCode !== 0 || result.truncated) throw uncertain();
      let state: {
        id: string;
        owner: string;
        running: boolean;
        status: string;
        exitCode: number;
      };
      try {
        state = JSON.parse(result.stdout);
      } catch {
        throw uncertain();
      }
      if (
        state.owner !== id ||
        state.id !== receipt.containerId ||
        typeof state.running !== "boolean" ||
        !Number.isInteger(state.exitCode)
      )
        throw uncertain();
      return state;
    };
    try {
      save();
      const fd = openSync(envPath, "wx", 0o600);
      try {
        writeFileSync(fd, env);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      syncDirectory(owned);
      createAttempted = true;
      const result = await this.command(
        [
          "create",
          "--pull=never",
          "--name",
          name,
          "--label",
          `${label}=${id}`,
          "--env-file",
          envPath,
          "--mount",
          `type=bind,src=${workspace},dst=/workspace`,
          "--workdir",
          "/workspace",
          "--entrypoint",
          "/bin/sh",
          step.image,
          "-c",
          'command=$CIFN_INTERNAL_COMMAND; unset CIFN_INTERNAL_COMMAND; eval "$command"',
        ],
        workspace,
        step.signal,
        undefined,
        60000,
        { CIFN_INTERNAL_COMMAND: step.command },
      );
      if (
        result.exitCode !== 0 ||
        result.truncated ||
        !/^[a-f0-9]{64}$/.test(result.stdout.trim())
      )
        throw uncertain();
      receipt.containerId = result.stdout.trim();
      created = true;
      save();
      rmSync(envPath);
      syncDirectory(owned);
      await inspect();
      let outputFailure = false;
      const onLines = step.onLines
        ? (lines: string[]) => {
            try {
              step.onLines!(lines);
            } catch {
              outputFailure = true;
            }
          }
        : undefined;
      const output = await this.command(
        ["start", "--attach", name],
        workspace,
        step.signal,
        onLines,
        this.timeout,
      );
      if (outputFailure)
        throw new Error("Container output could not be persisted");
      if (output.truncated || step.signal?.aborted)
        return { ...output, exitCode: 1 };
      const state = await inspect();
      if (
        state.running ||
        state.status !== "exited" ||
        output.exitCode !== state.exitCode
      )
        throw uncertain();
      return { ...output, exitCode: state.exitCode };
    } catch (error) {
      if (error instanceof ProcessGroupUncertainError) cliUncertain = true;
      throw error;
    } finally {
      // Never equate termination of docker CLI with termination of its daemon-owned container.
      if (created) {
        try {
          const current = await this.command(
            ["info", "--format", "{{.ID}}"],
            workspace,
            undefined,
            undefined,
            5000,
          );
          if (
            current.exitCode !== 0 ||
            current.truncated ||
            current.stdout.trim() !== daemonId
          )
            throw uncertain();
          await inspect();
          const removed = await this.command(
            ["rm", "--force", receipt.containerId],
            workspace,
            undefined,
            undefined,
            10000,
          );
          if (removed.exitCode !== 0 || removed.truncated) throw uncertain();
          const remaining = await this.command(
            [
              "container",
              "ls",
              "--all",
              "--no-trunc",
              "--filter",
              `name=^/${name}$`,
              "--format",
              "{{.ID}}",
            ],
            workspace,
            undefined,
            undefined,
            10000,
          );
          if (
            remaining.exitCode !== 0 ||
            remaining.truncated ||
            remaining.stdout.trim()
          )
            throw uncertain();
          if (!cliUncertain) {
            rmSync(owned, { recursive: true });
            syncDirectory(this.directory);
          }
        } catch {
          throw uncertain();
        }
      } else if (!createAttempted) {
        rmSync(owned, { recursive: true });
        syncDirectory(this.directory);
      } else {
        throw uncertain();
      }
      // Ambiguous create requests can complete in the daemon after the CLI exits. Keep receipt/workspace.
    }
  }
}
