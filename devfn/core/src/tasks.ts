import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, readlink, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { ComposeController, composeTaskSourceDigest, createComposeEnvironment, type ComposeLaunch } from "@devfn/compose";
import { resolveContainedPath, type DevFnConfig, type TaskSpec } from "@devfn/config";
import { FilePortRegistry, withFileLock } from "@devfn/ports";
import { createProcessEnvironment, resolveAdapterCommand, ProcessSupervisor, stopGatedLauncher, type ProcessRunResult } from "@devfn/processes";

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
  /** A Compose attempt's one-off launch, so a start from any worktree sharing the journal can find a container it left. */
  compose?: Omit<ComposeLaunch, "name" | "launcher">;
  /** Nothing the attempt ran is left: its process group and any one-off container are verified gone. */
  stopped?: boolean;
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
 * receipts and teardown. Attempts are bounded to the latest MAX_ATTEMPTS,
 * plus the older ones the rerun contract still depends on.
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
/** Wait, or less once the signal aborts. */
const delay = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
  const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); };
  const timer = setTimeout(done, ms);
  signal?.addEventListener("abort", done, { once: true });
});
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
 * Credential-safe digest of a Compose task's sources: a rotated literal secret is not a changed input.
 * Its sources are selected with the Compose environment startup gives the node, built from its resolved values.
 */
async function digestComposeSource(root: string, spec: NonNullable<DevFnConfig["services"]>[string], field: string, environment: Record<string, string>): Promise<string> {
  const relative = spec.file ?? "compose.yaml";
  const file = await resolveContainedPath(root, relative, field).catch((error: unknown) => {
    throw new DevFnError("DEVFN_RUNTIME_INVALID", `${field}: ${error instanceof Error ? error.message : String(error)}`);
  });
  const stats = await stat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new DevFnError("DEVFN_RUNTIME_INVALID", `${field} ${relative} does not exist.`);
    throw error;
  });
  if (!stats.isFile()) throw new DevFnError("DEVFN_RUNTIME_INVALID", `${field} ${relative} is not a file.`);
  try { return await composeTaskSourceDigest(spec, root, createComposeEnvironment({ ...spec, env: environment }, environment)); }
  catch (error) { throw new DevFnError("DEVFN_RUNTIME_INVALID", `${field}: ${error instanceof Error ? error.message : String(error)}`); }
}

/** Resource value sources that carry a leased host port; a reallocated port never reruns a task. */
const LEASED_SOURCES = new Set(["lease", "host-gateway"]);

/**
 * The input revision of a task: its declared command and settings, its
 * manifest and selected profile environment as written (secret channels by
 * name only), the targets, namespaces and values of the resources it consumes
 * as that node receives them, its Compose sources and the content of its
 * declared inputs. Leased ports, secret values and values inherited from the
 * host through envAllowlist are not part of it, so a reallocated port, a
 * rotated credential or another shell never reruns a task. The node's
 * resolved startup environment (by default its profile and manifest
 * environment as written) only selects the Compose sources, as at startup.
 */
export async function taskInputRevision(config: DevFnConfig, root: string, node: { name: string; kind: "process" | "service" }, profile: string, resources?: ResourcePlan,
  environment?: Record<string, string>): Promise<string> {
  const { spec, task, field } = taskNode(config, node);
  const sorted = (values: readonly string[] | undefined) => [...(values ?? [])].sort(compare);
  const entries = (values: Record<string, string> | undefined) => Object.entries(values ?? {}).sort(([a], [b]) => compare(a, b));
  const settings = node.kind === "process"
    ? { adapter: config.processes![node.name].adapter, command: config.processes![node.name].command ?? [], script: config.processes![node.name].script ?? null, cwd: config.processes![node.name].cwd ?? "." }
    : { file: config.services![node.name].file ?? "compose.yaml", service: config.services![node.name].service, projectName: config.services![node.name].projectName ?? "devfn",
      source: await digestComposeSource(root, config.services![node.name], `${field}.file`, environment ?? { ...config.profiles[profile]?.environment, ...spec.env }) };
  const consumed = sorted(spec.resources).map((name) => {
    const planned = resources?.resources[name];
    if (!planned) return [name, null];
    // What this node receives: a Compose service its container-side view, a native process the host-side values.
    const received = node.kind === "service" ? planned.services[node.name] ?? {} : planned.values;
    const values = Object.entries(received).flatMap(([key, value]) => "unreachable" in value || LEASED_SOURCES.has(value.source) ? [] : [[key, value.value]]).sort((a, b) => compare(a[0], b[0]));
    return [name, { kind: planned.kind, target: planned.target?.name ?? null, location: planned.target?.location ?? null, remote: planned.remote?.url ?? null,
      provider: planned.provider ? [planned.provider.node, planned.provider.port] : null, namespace: planned.namespace?.prefix ?? null, values }];
  });
  const inputs: Array<[string, string]> = [];
  for (const [index, input] of (task.inputs ?? []).entries()) inputs.push([input, await digestInput(root, input, `${field}.task.inputs[${index}]`)]);
  return sha256(JSON.stringify({ version: 1, kind: node.kind, settings, env: entries(spec.env), profileEnv: entries(config.profiles[profile]?.environment),
    envAllowlist: sorted(spec.envAllowlist), secretEnv: sorted(spec.secretEnv), resources: consumed, inputs }));
}

/**
 * The journal and lock a task's completion is recorded under, classified
 * from the same consumed resources its input revision covers. A consumed
 * target is shared across worktrees when it is remote and no isolated
 * namespace separates them: a shared namespace, or a remote resource without
 * one (a service). Local targets, which a lifecycle starts, and isolated
 * namespaces, a browser's included, are per instance. A browser resource
 * with a shared namespace names the same state in every worktree, so it is
 * neither. Every input of a shared-scope revision is therefore identical in
 * every worktree. A task consuming
 * shared targets changes the same systems from every worktree, so its scope
 * is the project, task and those targets, and every worktree decides from,
 * and serializes on, one record. Any other task's scope is its lifecycle
 * instance. A task consuming both would need its per-instance targets set up
 * in each worktree but must never run twice against the shared ones, so it
 * is rejected before any mutation.
 */
export function taskScope(config: DevFnConfig, instanceId: string, node: { name: string; kind: "process" | "service" }, resources?: ResourcePlan): { key: string; scope: TaskJournal["scope"] } {
  const { spec } = taskNode(config, node);
  const consumed = (spec.resources ?? []).flatMap((name) => {
    const planned = resources?.resources[name];
    return planned && !(planned.kind === "browser" && planned.namespace?.sharing === "shared") ? [[name, planned] as const] : [];
  });
  const shared = consumed.filter(([, planned]) => planned.remote && (!planned.namespace || planned.namespace.sharing === "shared"));
  const instance = consumed.filter((item) => !shared.includes(item)).map(([name]) => name);
  if (shared.length > 0 && instance.length > 0) {
    throw new DevFnError("DEVFN_RUNTIME_INVALID", `Task ${node.name} consumes resources shared across worktrees (${shared.map(([name]) => name).join(", ")}) and per-instance resources (${instance.join(", ")}). Its completion cannot be recorded once for the shared targets and once per instance; split it into tasks that each consume only one kind.`,
      { task: node.name, shared: shared.map(([name]) => name), instance });
  }
  const identity = shared.length > 0
    ? { project: config.project.id, task: node.name, targets: shared.map(([name, planned]) => [name, planned.remote!.url, planned.namespace?.prefix ?? null]).sort((a, b) => compare(a[0]!, b[0]!)) }
    : { project: config.project.id, task: node.name, instance: instanceId };
  return { key: sha256(JSON.stringify(identity)).slice(0, 40), scope: shared.length > 0 ? "shared" : "instance" };
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

/**
 * The attempts a journal keeps. History beyond the latest MAX_ATTEMPTS is
 * diagnostic only, except what the next decision depends on: the last
 * success, the latest attempts since it that may have partly applied (also
 * the latest of them that ended), and every attempt not verified stopped.
 * Gate-closed attempts can therefore never evict an unresolved one.
 */
function lastSuccessIndex(attempts: readonly TaskAttempt[]): number {
  let index = attempts.length - 1;
  while (index >= 0 && attempts[index].outcome !== "succeeded") index -= 1;
  return index;
}

function retainedAttempts(attempts: readonly TaskAttempt[]): TaskAttempt[] {
  if (attempts.length <= MAX_ATTEMPTS) return [...attempts];
  const keep = new Set(attempts.slice(-MAX_ATTEMPTS));
  const success = lastSuccessIndex(attempts);
  if (success >= 0) keep.add(attempts[success]);
  const unresolved = attempts.slice(success + 1).filter((attempt) => attempt.effects !== "none");
  for (const attempt of [unresolved.at(-1), unresolved.filter((item) => item.outcome !== "running").at(-1)]) if (attempt) keep.add(attempt);
  for (const attempt of attempts) if (attempt.launcher && attempt.stopped !== true) keep.add(attempt);
  return attempts.filter((attempt) => keep.has(attempt));
}

async function writeTaskJournal(stateDir: string, key: string, journal: TaskJournal): Promise<void> {
  const file = journalPath(stateDir, key);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify({ ...journal, attempts: retainedAttempts(journal.attempts) }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temp, file);
}

type Decision = { run: boolean; reason: string };

/**
 * Attempts after the recorded success (all of them without one) that may
 * have partly applied: a success never masks a later attempt of unknown
 * effect. An unfinished attempt is judged only under the task lock (pending).
 */
function unresolvedAttempts(journal: TaskJournal | undefined, pending: boolean): TaskAttempt[] {
  const attempts = journal?.attempts ?? [];
  return attempts.slice(lastSuccessIndex(attempts) + 1).filter((attempt) => attempt.effects !== "none" && !(pending && attempt.outcome === "running"));
}

/**
 * The rerun contract, in order: an explicit rerun runs; a non-idempotent
 * task with an attempt since its last success that may have partly applied
 * blocks until explicitly rerun, and an idempotent one reruns (a "once" task
 * only at that attempt's or its success's revision); "always" runs; a
 * success recorded for the current input revision skips; "once" after a
 * success with another revision blocks; anything else runs.
 */
function decide(journal: TaskJournal | undefined, revision: string, task: TaskSpec, name: string, rerunRequested: boolean, pending = false): Decision {
  if (rerunRequested) return { run: true, reason: "rerun requested" };
  const unresolved = unresolvedAttempts(journal, pending).at(-1);
  if (unresolved && !task.idempotent) {
    throw new DevFnError("DEVFN_TASK_RERUN_REQUIRED", `Task ${name} is not idempotent and an attempt since its last success ended ${unresolved.outcome} (invocation ${unresolved.invocationId}); it may have partly applied and was not reverted. Inspect its effects, then rerun it explicitly with --rerun-task ${name}.`,
      { task: name, attempt: unresolved });
  }
  if (task.rerun === "always") return { run: true, reason: "rerun always" };
  if (unresolved && (task.rerun !== "once" || !journal?.lastSuccess || [unresolved.inputRevision, journal.lastSuccess.inputRevision].includes(revision))) {
    return { run: true, reason: `an attempt since the last success ended ${unresolved.outcome} with unknown effects` };
  }
  if (journal?.lastSuccess?.inputRevision === revision) return { run: false, reason: "succeeded for this input revision" };
  if (task.rerun === "once" && journal?.lastSuccess) {
    throw new DevFnError("DEVFN_TASK_INPUT_CHANGED", `Task ${name} runs once and already succeeded for another input revision; rerun it explicitly with --rerun-task ${name} to apply the change.`,
      { task: name, recordedRevision: journal.lastSuccess.inputRevision, currentRevision: revision });
  }
  return { run: true, reason: journal?.lastSuccess ? "input revision changed" : "no recorded success" };
}

/** A task's scope lock is held for its whole retry budget, which is also how long a start waits for it. */
const scopeLockTimeout = (task: TaskSpec) => (task.timeoutMs ?? 600_000) * (1 + (task.retries ?? 0)) + 60_000;
/**
 * A holder verified dead by its recorded birth signature is taken over after
 * this long, well within any waiter's timeout, so a start from another
 * worktree recovers the scope instead of timing out behind a dead DevFn.
 */
const SCOPE_LOCK_STALE_MS = 10_000;
const lockPath = (stateDir: string, key: string) => path.join(stateDir, "tasks", `${key}.lock`);

/**
 * Before a scope decides, nothing an earlier attempt ran may remain. The
 * scope lock is held, so the DevFn that ran an unverified attempt is gone or
 * already gave up stopping it; what it left (its process group, or a one-off
 * container dockerd owns, which a gone `docker compose run` does not prove
 * gone) is stopped through the journaled identities. A running attempt is
 * then recorded interrupted, never reverted. Anything that cannot be
 * verified stopped blocks every start of the scope, explicit reruns too.
 */
async function settleAttempts(journal: TaskJournal, name: string, compose: () => ComposeController, write: () => Promise<void>): Promise<void> {
  for (const attempt of journal.attempts.filter((item) => item.launcher && item.stopped !== true)) {
    try {
      if (attempt.compose) await compose().stopLaunch({ name, ...attempt.compose, launcher: attempt.launcher });
      else await stopGatedLauncher(attempt.launcher!);
    } catch (error) {
      throw new DevFnError("DEVFN_TASK_RERUN_REQUIRED", `An earlier attempt of task ${name} (invocation ${attempt.invocationId}, launcher PID ${attempt.launcher!.pid}) may still run and could not be stopped: ${error instanceof Error ? error.message : String(error)} Stop it, then start again.`,
        { task: name, attempt });
    }
    attempt.stopped = true;
    if (attempt.outcome === "running") Object.assign(attempt, { outcome: "interrupted", endedAt: new Date().toISOString(), effects: "unknown" });
    await write();
  }
}

/**
 * Validate explicit reruns and decide every selected task from its journal,
 * before anything is mutated. The early pass reads journals as they are; the
 * locked pass (under the lifecycle lock, before any lease, replacement or
 * node) waits for each task's scope lock, settles what earlier attempts left
 * and decides from the outcomes concurrent starts recorded meanwhile.
 */
export async function preflightTasks(input: { config: DevFnConfig; plan: LifecyclePlan; root: string; stateDir: string; instanceId: string; resources?: ResourcePlan;
  /** Resolved startup environment of each node, by name. */
  environments?: Record<string, { environment: Record<string, string> }>; rerunTasks?: readonly string[];
  locked?: { compose?: ComposeController; signal?: AbortSignal } }): Promise<void> {
  const tasks = input.plan.nodes.filter((node) => node.task);
  for (const name of input.rerunTasks ?? []) {
    if (!tasks.some((node) => node.name === name)) throw new DevFnError("DEVFN_RUNTIME_INVALID", `--rerun-task ${name} names no task of profile ${input.plan.profile}.`);
  }
  for (const node of tasks) {
    const revision = await taskInputRevision(input.config, input.root, node, input.plan.profile, input.resources, input.environments?.[node.name]?.environment);
    const { key } = taskScope(input.config, input.instanceId, node, input.resources);
    const { task } = taskNode(input.config, node);
    const rerunRequested = input.rerunTasks?.includes(node.name) ?? false;
    if (!input.locked) {
      decide(await readTaskJournal(input.stateDir, key), revision, task, node.name, rerunRequested, true);
      continue;
    }
    const { compose, signal } = input.locked;
    await mkdir(path.join(input.stateDir, "tasks"), { recursive: true, mode: 0o700 });
    await withFileLock(lockPath(input.stateDir, key), async () => {
      const journal = await readTaskJournal(input.stateDir, key);
      if (journal) await settleAttempts(journal, node.name, () => compose ?? new ComposeController(), async () => await writeTaskJournal(input.stateDir, key, journal));
      decide(journal, revision, task, node.name, rerunRequested);
    }, { timeoutMs: scopeLockTimeout(task), staleMs: SCOPE_LOCK_STALE_MS, ...(signal ? { signal } : {}) }).catch((error: unknown) => {
      if (signal?.aborted) throw new DevFnError("DEVFN_CANCELLED", `DevFn startup was cancelled while task ${node.name} was decided; nothing was started.`, { task: node.name });
      throw error;
    });
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
  /** Selected profile, whose environment is part of the input revision. */
  profile: string;
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
  const revision = await taskInputRevision(config, context.root, node, context.profile, context.resources, context.environment);
  const { key, scope } = taskScope(config, context.instanceId, node, context.resources);
  await mkdir(path.join(stateDir, "tasks"), { recursive: true, mode: 0o700 });
  const attemptsAllowed = 1 + (task.retries ?? 0);
  const timeoutMs = task.timeoutMs ?? 600_000;
  let locked = false;
  return await withFileLock(lockPath(stateDir, key), async () => {
    locked = true;
    const journal: TaskJournal = await readTaskJournal(stateDir, key) ?? { version: 1, task: node.name, scope, attempts: [] };
    await settleAttempts(journal, node.name, () => context.compose ?? new ComposeController(), async () => await writeTaskJournal(stateDir, key, journal));
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
        result = await runAttempt(context, spec, timeoutMs, number, async (launcher, compose) => {
          // The attempt and what can find its leftovers are journaled before its command may start.
          Object.assign(attempt, { launcher, ...(compose ? { compose } : {}) });
          journal.attempts.push(attempt);
          receipt.attempts.push(attempt);
          await writeTaskJournal(stateDir, key, journal);
          await context.record(receipt);
        });
      } catch (error) {
        // runAttempt throws only while the launch gate is closed: the command never ran.
        Object.assign(attempt, { outcome: context.signal?.aborted ? "cancelled" : "failed", effects: "none", stopped: true, endedAt: new Date().toISOString(),
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
        effects: outcome === "succeeded" ? "applied" : "unknown", stopped: !result.stopError, ...(error ? { error } : {}) });
      receipt.logPath = result.process.logPath;
      if (outcome === "succeeded") {
        journal.lastSuccess = { inputRevision: revision, invocationId: context.invocationId, instanceId: context.instanceId, completedAt: attempt.endedAt! };
        receipt.lastSuccess = journal.lastSuccess;
      }
      await writeTaskJournal(stateDir, key, journal);
      receipt.status = outcome;
      await context.record(receipt);
      if (outcome === "succeeded" || outcome === "cancelled") break;
      // An attempt that may still run is never overlapped by a retry; its launch stays journaled for teardown, and the next start of the scope settles it first.
      if (result.stopError) break;
      if (number < attemptsAllowed) await delay(Math.min(1_000 * number, 10_000), context.signal);
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
      throw new DevFnError("DEVFN_TASK_TIMEOUT", `Task ${node.name} exceeded ${timeoutMs} ms after ${receipt.attempts.length} attempt(s)${last?.error ? ` (${last.error})` : " and was stopped"}; its dependents were not started. ${effects}`, { task: node.name });
    }
    throw new DevFnError("DEVFN_TASK_FAILED", `Task ${node.name} exited with ${last?.signal ? `signal ${last.signal}` : `code ${String(last?.exitCode)}`} after ${receipt.attempts.length} attempt(s)${last?.error ? ` (${last.error})` : ""}; its dependents were not started. ${effects}`,
      { task: node.name, exitCode: last?.exitCode ?? null });
  }, { timeoutMs: scopeLockTimeout(task), staleMs: SCOPE_LOCK_STALE_MS, ...(context.signal ? { signal: context.signal } : {}) }).catch((error: unknown) => {
    // Cancelled while another start of this scope held its lock: nothing of this task ran.
    if (!locked && context.signal?.aborted) throw new DevFnError("DEVFN_CANCELLED", `Task ${node.name} was cancelled before it started; its dependents were not started.`, { task: node.name });
    throw error;
  });
}

/** One attempt: a native command, or a one-off Compose container whose launch stays journaled until nothing of it remains. */
async function runAttempt(context: RunTaskContext, spec: ReturnType<typeof taskNode>["spec"], timeoutMs: number, number: number,
  journal: (launcher: { pid: number; birthSignature?: string }, compose?: TaskAttempt["compose"]) => Promise<void>): Promise<ProcessRunResult> {
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
  // Compose may give the container secret values from sources the host
  // environment does not show (an env file), which redaction cannot know, so
  // a task with secret channels keeps none of its output, as a started
  // service with them logs nothing.
  const discardOutput = (spec.secretEnv?.length ?? 0) > 0;
  const prepared = await compose.prepareTask({ name: node.name, spec: serviceSpec, root: context.root, runtimeDir: context.runtimeDir, instanceId: context.instanceId, environment: context.environment,
    attempt: `${invocationId}.${number}` });
  let launcher: { pid: number; birthSignature?: string } | undefined;
  const result = await supervisor.run({ ...common, command: prepared.command, environment: prepared.environment, ...(discardOutput ? { discardOutput } : {}),
    onStarted: async (managed) => {
      launcher = { pid: managed.pid, ...(managed.birthSignature ? { birthSignature: managed.birthSignature } : {}) };
      await journal(launcher, withoutName(prepared.launch));
      await registry.beginLaunch(invocationId, node.name, { ...withoutName(prepared.launch), launcher });
    } });
  // --rm removes a container that ran to its end, but a run that did not end
  // there may have left one, and Docker may not have removed it yet: every
  // attempt's one-off containers, found by its attempt label, are stopped and
  // removed, and verified gone, before the launch is resolved. A launch that
  // cannot be resolved stays journaled for teardown and fails the attempt.
  try { await compose.stopLaunch({ ...prepared.launch, ...(launcher ? { launcher } : {}) }); }
  catch (error) { return { ...result, stopError: [result.stopError, error instanceof Error ? error.message : String(error)].filter(Boolean).join(" ") }; }
  try { if (launcher) await registry.recordOwners(invocationId, node.name, [{ process: launcher }]); }
  catch (error) { return { ...result, stopError: [result.stopError, error instanceof Error ? error.message : String(error)].filter(Boolean).join(" ") }; }
  return result;
}
const withoutName = <T extends { name: string }>({ name: _name, ...rest }: T): Omit<T, "name"> => rest;
