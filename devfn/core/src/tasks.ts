import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, readlink, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { ComposeController } from "@devfn/compose";
import { resolveContainedPath, type DevFnConfig, type TaskSpec } from "@devfn/config";
import { FilePortRegistry, withFileLock } from "@devfn/ports";
import { createProcessEnvironment, gatedLauncherStatus, resolveAdapterCommand, ProcessSupervisor, type ProcessRunResult } from "@devfn/processes";

import type { ResourcePlan } from "./resources.js";
import { DevFnError, type LifecyclePlan } from "./types.js";

/**
 * What an attempt left in the systems it changed. A success's effects are
 * applied; any other started attempt may have applied part of its work.
 * Stopping a task, or rolling back a failed start, never reverts either.
 */
export type TaskEffects = "none" | "applied" | "unknown";

export interface TaskAttempt {
  invocationId: string;
  instanceId: string;
  /** 1-based within its invocation. */
  attempt: number;
  inputRevision: string;
  startedAt: string;
  endedAt?: string;
  /** "running" is recorded before the command may start; one found by a later start was interrupted. */
  outcome: "running" | "succeeded" | "failed" | "timed-out" | "cancelled" | "interrupted";
  exitCode?: number | null;
  signal?: string | null;
  effects: TaskEffects;
  /** The gated launcher identity, recorded before the command could run. */
  launcher?: { pid: number; birthSignature?: string };
  error?: string;
}

export interface TaskReceipt {
  name: string;
  kind: "process" | "service";
  rerun: NonNullable<TaskSpec["rerun"]>;
  idempotent: boolean;
  inputRevision: string;
  status: "succeeded" | "skipped" | "failed" | "timed-out" | "cancelled";
  /** Why it ran or was skipped. */
  reason: string;
  /** Attempts of this invocation; earlier ones stay in the task journal. */
  attempts: TaskAttempt[];
  logPath?: string;
  lastSuccess?: TaskJournal["lastSuccess"];
}

/**
 * Durable completion record of one task scope, kept in machine state across
 * receipts and teardown. Attempts are bounded to the latest MAX_ATTEMPTS.
 */
export interface TaskJournal {
  version: 1;
  task: string;
  scope: "instance" | "shared";
  lastSuccess?: { inputRevision: string; invocationId: string; instanceId: string; completedAt: string };
  attempts: TaskAttempt[];
}

const MAX_ATTEMPTS = 20;
const MAX_INPUT_ENTRIES = 10_000;
const MAX_INPUT_BYTES = 256 * 1024 * 1024;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function taskNode(config: DevFnConfig, node: { name: string; kind: "process" | "service" }) {
  const spec = node.kind === "process" ? config.processes![node.name] : config.services![node.name];
  return { spec, task: spec.task!, field: `${node.kind === "process" ? "processes" : "services"}.${node.name}` };
}

/** Content digest of a repository file or directory; symlinks are hashed as links, never followed. */
async function digestInput(root: string, relative: string, field: string): Promise<string> {
  const target = await resolveContainedPath(root, relative, field).catch((error: unknown) => {
    throw new DevFnError("DEVFN_RUNTIME_INVALID", `${field}: ${error instanceof Error ? error.message : String(error)}`);
  });
  const hash = createHash("sha256");
  const budget = { entries: 0, bytes: 0 };
  const visit = async (absolute: string, name: string): Promise<void> => {
    if (++budget.entries > MAX_INPUT_ENTRIES) throw new DevFnError("DEVFN_RUNTIME_INVALID", `${field} lists more than ${MAX_INPUT_ENTRIES} entries.`);
    const stats = await lstat(absolute).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") throw new DevFnError("DEVFN_RUNTIME_INVALID", `${field} ${relative} does not exist.`);
      throw error;
    });
    if (stats.isSymbolicLink()) hash.update(`l\0${name}\0${await readlink(absolute)}\0`);
    else if (stats.isDirectory()) {
      hash.update(`d\0${name}\0`);
      for (const entry of (await readdir(absolute)).sort(compare)) await visit(path.join(absolute, entry), `${name}/${entry}`);
    } else if (stats.isFile()) {
      budget.bytes += stats.size;
      if (budget.bytes > MAX_INPUT_BYTES) throw new DevFnError("DEVFN_RUNTIME_INVALID", `${field} exceeds ${MAX_INPUT_BYTES} bytes.`);
      hash.update(`f\0${name}\0${sha256(await readFile(absolute))}\0`);
    } else hash.update(`o\0${name}\0`);
  };
  await visit(target, ".");
  return hash.digest("hex");
}

/**
 * The input revision of a task: its declared command and settings, its
 * manifest environment (secret channels by name only), the resource targets
 * and namespaces it consumes, its Compose file and the content of its
 * declared inputs. Leased ports and secret values are not part of it, so a
 * reallocated port or a rotated credential never reruns a task.
 */
export async function taskInputRevision(config: DevFnConfig, root: string, node: { name: string; kind: "process" | "service" }, resources?: ResourcePlan): Promise<string> {
  const { spec, task, field } = taskNode(config, node);
  const sorted = (values: readonly string[] | undefined) => [...(values ?? [])].sort(compare);
  const settings = node.kind === "process"
    ? { adapter: config.processes![node.name].adapter, command: config.processes![node.name].command ?? [], script: config.processes![node.name].script ?? null, cwd: config.processes![node.name].cwd ?? "." }
    : { file: config.services![node.name].file ?? "compose.yaml", service: config.services![node.name].service, projectName: config.services![node.name].projectName ?? "devfn",
      source: await digestInput(root, config.services![node.name].file ?? "compose.yaml", `${field}.file`) };
  const consumed = sorted(spec.resources).map((name) => {
    const planned = resources?.resources[name];
    return [name, planned ? { kind: planned.kind, target: planned.target?.name ?? null, location: planned.target?.location ?? null, remote: planned.remote?.url ?? null,
      provider: planned.provider ? [planned.provider.node, planned.provider.port] : null, namespace: planned.namespace?.prefix ?? null } : null];
  });
  const inputs: Array<[string, string]> = [];
  for (const [index, input] of (task.inputs ?? []).entries()) inputs.push([input, await digestInput(root, input, `${field}.task.inputs[${index}]`)]);
  return sha256(JSON.stringify({ version: 1, kind: node.kind, settings, env: Object.entries(spec.env ?? {}).sort(([a], [b]) => compare(a, b)),
    envAllowlist: sorted(spec.envAllowlist), secretEnv: sorted(spec.secretEnv), resources: consumed, inputs }));
}

/**
 * The journal and lock a task's completion is recorded under. A task that
 * consumes only remote targets with shared namespaces changes the same
 * systems from every worktree, so its scope is the project, task and those
 * targets; any other task's is its lifecycle instance.
 */
export function taskScope(config: DevFnConfig, instanceId: string, node: { name: string; kind: "process" | "service" }, resources?: ResourcePlan): { key: string; scope: TaskJournal["scope"] } {
  const { spec } = taskNode(config, node);
  const consumed = (spec.resources ?? []).map((name) => [name, resources?.resources[name]] as const).filter(([, planned]) => planned?.kind !== "browser");
  const shared = consumed.length > 0 && consumed.every(([, planned]) => planned?.remote && planned.namespace?.sharing === "shared");
  const identity = shared
    ? { project: config.project.id, task: node.name, targets: consumed.map(([name, planned]) => [name, planned!.remote!.url, planned!.namespace!.prefix]).sort((a, b) => compare(a[0], b[0])) }
    : { project: config.project.id, task: node.name, instance: instanceId };
  return { key: sha256(JSON.stringify(identity)).slice(0, 40), scope: shared ? "shared" : "instance" };
}

const journalPath = (stateDir: string, key: string) => path.join(stateDir, "tasks", `${key}.json`);

export async function readTaskJournal(stateDir: string, key: string): Promise<TaskJournal | undefined> {
  const file = journalPath(stateDir, key);
  let raw: string;
  try { raw = await readFile(file, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let value: TaskJournal;
  try { value = JSON.parse(raw) as TaskJournal; }
  catch { value = undefined as unknown as TaskJournal; }
  if (!value || value.version !== 1 || !Array.isArray(value.attempts) || value.attempts.some((attempt) => !attempt || typeof attempt.outcome !== "string")) {
    // A completion record is evidence of work done to real systems; DevFn never guesses it.
    throw new DevFnError("DEVFN_RUNTIME_INVALID", `Task journal ${file} is malformed; restore it, or remove it to treat the task as never run.`);
  }
  return value;
}

async function writeTaskJournal(stateDir: string, key: string, journal: TaskJournal): Promise<void> {
  const file = journalPath(stateDir, key);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify({ ...journal, attempts: journal.attempts.slice(-MAX_ATTEMPTS) }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temp, file);
}

type Decision = { run: boolean; reason: string };

/**
 * The rerun contract, in order: an explicit rerun runs; a non-idempotent
 * task whose latest attempt may have partly applied blocks until explicitly
 * rerun; "always" runs; a success recorded for the current input revision
 * skips; "once" after a success with another revision blocks; anything else
 * runs. An unfinished attempt is judged only under the task lock (pending).
 */
function decide(journal: TaskJournal | undefined, revision: string, task: TaskSpec, name: string, rerunRequested: boolean, pending = false): Decision {
  if (rerunRequested) return { run: true, reason: "rerun requested" };
  const latest = journal?.attempts.at(-1);
  if (latest && latest.effects !== "none" && latest.outcome !== "succeeded" && !(pending && latest.outcome === "running") && !task.idempotent) {
    throw new DevFnError("DEVFN_TASK_RERUN_REQUIRED", `Task ${name} is not idempotent and its latest attempt ended ${latest.outcome} (invocation ${latest.invocationId}); it may have partly applied and was not reverted. Inspect its effects, then rerun it explicitly with --rerun-task ${name}.`,
      { task: name, attempt: latest });
  }
  if (task.rerun === "always") return { run: true, reason: "rerun always" };
  if (journal?.lastSuccess?.inputRevision === revision) return { run: false, reason: "succeeded for this input revision" };
  if (task.rerun === "once" && journal?.lastSuccess) {
    throw new DevFnError("DEVFN_TASK_INPUT_CHANGED", `Task ${name} runs once and already succeeded for another input revision; rerun it explicitly with --rerun-task ${name} to apply the change.`,
      { task: name, recordedRevision: journal.lastSuccess.inputRevision, currentRevision: revision });
  }
  return { run: true, reason: journal?.lastSuccess ? "input revision changed" : "no recorded success" };
}

/** Validate explicit reruns and decide every selected task from its journal, before anything is mutated. */
export async function preflightTasks(input: { config: DevFnConfig; plan: LifecyclePlan; root: string; stateDir: string; instanceId: string; resources?: ResourcePlan; rerunTasks?: readonly string[] }): Promise<void> {
  const tasks = input.plan.nodes.filter((node) => node.task);
  for (const name of input.rerunTasks ?? []) {
    if (!tasks.some((node) => node.name === name)) throw new DevFnError("DEVFN_RUNTIME_INVALID", `--rerun-task ${name} names no task of profile ${input.plan.profile}.`);
  }
  for (const node of tasks) {
    const revision = await taskInputRevision(input.config, input.root, node, input.resources);
    const { key } = taskScope(input.config, input.instanceId, node, input.resources);
    decide(await readTaskJournal(input.stateDir, key), revision, taskNode(input.config, node).task, node.name, input.rerunTasks?.includes(node.name) ?? false, true);
  }
}

export interface RunTaskContext {
  config: DevFnConfig;
  root: string;
  stateDir: string;
  runtimeDir: string;
  instanceId: string;
  invocationId: string;
  node: { name: string; kind: "process" | "service" };
  /** Resolved startup values of the node; DEVFN_* generated values are already part of them. */
  environment: Record<string, string>;
  command?: string[];
  script?: string;
  generated: Record<string, string>;
  resources?: ResourcePlan;
  rerunRequested: boolean;
  signal?: AbortSignal;
  registry: FilePortRegistry;
  supervisor?: ProcessSupervisor;
  compose?: ComposeController;
  /** Persist the receipt entry whenever it changes. */
  record: (receipt: TaskReceipt) => Promise<void>;
}

/**
 * Run one task to completion under its scope lock, so concurrent starts of
 * the same scope run it at most once at a time and later ones decide from
 * the outcome it recorded. Resolves once it succeeded or was skipped;
 * otherwise throws and its dependents never start.
 */
export async function runTask(context: RunTaskContext): Promise<TaskReceipt> {
  const { config, node, stateDir } = context;
  const { spec, task } = taskNode(config, node);
  const revision = await taskInputRevision(config, context.root, node, context.resources);
  const { key, scope } = taskScope(config, context.instanceId, node, context.resources);
  await mkdir(path.join(stateDir, "tasks"), { recursive: true, mode: 0o700 });
  const attemptsAllowed = 1 + (task.retries ?? 0);
  const timeoutMs = task.timeoutMs ?? 600_000;
  return await withFileLock(path.join(stateDir, "tasks", `${key}.lock`), async () => {
    const journal: TaskJournal = await readTaskJournal(stateDir, key) ?? { version: 1, task: node.name, scope, attempts: [] };
    // The scope lock is held, so a running attempt's DevFn is gone. Its
    // command must be gone too; it is recorded interrupted, never reverted.
    const unfinished = journal.attempts.at(-1);
    if (unfinished?.outcome === "running") {
      if (unfinished.launcher && await gatedLauncherStatus(unfinished.launcher) !== "gone") {
        throw new DevFnError("DEVFN_TASK_RERUN_REQUIRED", `An interrupted attempt of task ${node.name} (PID ${unfinished.launcher.pid}) may still run; stop it, then start again.`, { task: node.name });
      }
      Object.assign(unfinished, { outcome: "interrupted", endedAt: new Date().toISOString(), effects: "unknown" });
      await writeTaskJournal(stateDir, key, journal);
    }
    const decision = decide(journal, revision, task, node.name, context.rerunRequested);
    const receipt: TaskReceipt = { name: node.name, kind: node.kind, rerun: task.rerun ?? "on-change", idempotent: task.idempotent ?? false, inputRevision: revision,
      status: "skipped", reason: decision.reason, attempts: [], ...(journal.lastSuccess ? { lastSuccess: journal.lastSuccess } : {}) };
    if (!decision.run) { await context.record(receipt); return receipt; }
    for (let number = 1; number <= attemptsAllowed; number += 1) {
      if (context.signal?.aborted) break;
      const attempt: TaskAttempt = { invocationId: context.invocationId, instanceId: context.instanceId, attempt: number, inputRevision: revision,
        startedAt: new Date().toISOString(), outcome: "running", effects: "unknown" };
      let result: ProcessRunResult;
      try {
        result = await runAttempt(context, spec, timeoutMs, async (launcher) => {
          // The attempt is journaled before its command may start.
          attempt.launcher = launcher;
          journal.attempts.push(attempt);
          receipt.attempts.push(attempt);
          await writeTaskJournal(stateDir, key, journal);
          await context.record(receipt);
        });
      } catch (error) {
        // runAttempt throws only while the launch gate is closed: the command never ran.
        Object.assign(attempt, { outcome: context.signal?.aborted ? "cancelled" : "failed", effects: "none", endedAt: new Date().toISOString(),
          error: error instanceof Error ? error.message : String(error) });
        receipt.status = attempt.outcome === "cancelled" ? "cancelled" : "failed";
        if (journal.attempts.includes(attempt)) await writeTaskJournal(stateDir, key, journal).catch(() => undefined);
        await context.record(receipt).catch(() => undefined);
        if (context.signal?.aborted) throw new DevFnError("DEVFN_CANCELLED", `Task ${node.name} was cancelled before it started; its dependents were not started.`, { task: node.name });
        throw error;
      }
      // Something the task left behind that could not be stopped fails it, even after exit 0.
      const outcome = result.stopError && result.outcome === "succeeded" ? "failed" : result.outcome;
      const error = [result.error, result.stopError].filter(Boolean).join(" ");
      Object.assign(attempt, { outcome, exitCode: result.exitCode, signal: result.signal, endedAt: new Date().toISOString(),
        effects: outcome === "succeeded" ? "applied" : "unknown", ...(error ? { error } : {}) });
      receipt.logPath = result.process.logPath;
      if (outcome === "succeeded") {
        journal.lastSuccess = { inputRevision: revision, invocationId: context.invocationId, instanceId: context.instanceId, completedAt: attempt.endedAt! };
        receipt.lastSuccess = journal.lastSuccess;
      }
      await writeTaskJournal(stateDir, key, journal);
      receipt.status = outcome;
      await context.record(receipt);
      if (outcome === "succeeded" || outcome === "cancelled") break;
      if (number < attemptsAllowed) await delay(Math.min(1_000 * number, 10_000));
    }
    if (receipt.status === "succeeded") return receipt;
    const last = receipt.attempts.at(-1);
    const effects = "Its effects are unknown and were not reverted.";
    if (context.signal?.aborted || receipt.status === "cancelled") {
      receipt.status = "cancelled";
      await context.record(receipt);
      throw new DevFnError("DEVFN_CANCELLED", `Task ${node.name} was cancelled; its dependents were not started. ${last ? effects : ""}`.trim(), { task: node.name });
    }
    if (receipt.status === "timed-out") {
      throw new DevFnError("DEVFN_TASK_TIMEOUT", `Task ${node.name} exceeded ${timeoutMs} ms after ${receipt.attempts.length} attempt(s) and was stopped; its dependents were not started. ${effects}`, { task: node.name });
    }
    throw new DevFnError("DEVFN_TASK_FAILED", `Task ${node.name} exited with ${last?.signal ? `signal ${last.signal}` : `code ${String(last?.exitCode)}`} after ${receipt.attempts.length} attempt(s)${last?.error ? ` (${last.error})` : ""}; its dependents were not started. ${effects}`,
      { task: node.name, exitCode: last?.exitCode ?? null });
  }, { timeoutMs: timeoutMs * attemptsAllowed + 60_000 });
}

/** One attempt: a native command, or a one-off Compose container whose launch stays journaled until nothing of it remains. */
async function runAttempt(context: RunTaskContext, spec: ReturnType<typeof taskNode>["spec"], timeoutMs: number,
  journal: (launcher: { pid: number; birthSignature?: string }) => Promise<void>): Promise<ProcessRunResult> {
  const supervisor = context.supervisor ?? new ProcessSupervisor();
  const { node, registry, invocationId } = context;
  const common = { name: node.name, root: context.root, runtimeDir: context.runtimeDir, timeoutMs, redactKeys: spec.secretEnv ?? [], ...(context.signal ? { signal: context.signal } : {}) };
  if (node.kind === "process") {
    const processSpec = { ...context.config.processes![node.name], env: context.environment, command: context.command, script: context.script };
    return await supervisor.run({ ...common, command: resolveAdapterCommand(processSpec), cwd: processSpec.cwd, environment: createProcessEnvironment(processSpec, context.generated),
      ...(processSpec.shutdownTimeoutMs === undefined ? {} : { shutdownTimeoutMs: processSpec.shutdownTimeoutMs }),
      onStarted: async (managed) => {
        const launcher = { pid: managed.pid, ...(managed.birthSignature ? { birthSignature: managed.birthSignature } : {}) };
        await journal(launcher);
        await registry.recordOwners(invocationId, node.name, [{ process: launcher }]);
      } });
  }
  const compose = context.compose ?? new ComposeController();
  const serviceSpec = { ...context.config.services![node.name], env: context.environment };
  const prepared = await compose.prepareTask({ name: node.name, spec: serviceSpec, root: context.root, runtimeDir: context.runtimeDir, instanceId: context.instanceId, environment: context.environment });
  let launcher: { pid: number; birthSignature?: string } | undefined;
  const result = await supervisor.run({ ...common, command: prepared.command, environment: prepared.environment,
    onStarted: async (managed) => {
      launcher = { pid: managed.pid, ...(managed.birthSignature ? { birthSignature: managed.birthSignature } : {}) };
      await journal(launcher);
      await registry.beginLaunch(invocationId, node.name, { ...withoutName(prepared.launch), launcher });
    } });
  // --rm removes a container that ran to its end; any other run may have
  // left one, which is stopped and removed before the launch is resolved.
  // A launch that cannot be resolved stays journaled for teardown.
  if (result.outcome !== "succeeded") {
    try { await compose.stopLaunch({ ...prepared.launch, ...(launcher ? { launcher } : {}) }); }
    catch (error) { return { ...result, stopError: [result.stopError, error instanceof Error ? error.message : String(error)].filter(Boolean).join(" ") }; }
  }
  try { if (launcher) await registry.recordOwners(invocationId, node.name, [{ process: launcher }]); }
  catch (error) { return { ...result, stopError: [result.stopError, error instanceof Error ? error.message : String(error)].filter(Boolean).join(" ") }; }
  return result;
}
const withoutName = <T extends { name: string }>({ name: _name, ...rest }: T): Omit<T, "name"> => rest;
