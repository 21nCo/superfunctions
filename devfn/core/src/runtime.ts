import { randomBytes, randomUUID } from "node:crypto";
import { chmod, link, mkdir, open, readdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { resolveContainedPath, type DevFnConfig, type EnvironmentOutput } from "@devfn/config";
import { DEFAULT_RUNTIME, isNamedRuntime, resolveInstanceIdentity } from "./identity.js";
import { DevFnError, type LifecycleReceipt } from "./types.js";

export function runtimeDirectory(config: DevFnConfig, root: string, instanceId: string): string {
  return path.join(root, config.runtimeDir ?? ".devfn", "instances", instanceId);
}

export async function secureRuntimeDirectory(config: DevFnConfig, root: string, instanceId: string): Promise<string> {
  return await resolveContainedPath(root, path.join(config.runtimeDir ?? ".devfn", "instances", instanceId), "runtimeDir");
}

export function receiptPath(config: DevFnConfig, root: string, instanceId: string): string {
  return path.join(runtimeDirectory(config, root, instanceId), "receipt.json");
}

async function stableReceiptPath(root: string, instanceId: string): Promise<string> {
  return await resolveContainedPath(root, path.join(".devfn", "receipts", `${instanceId}.json`), "receipt");
}

/** A parsed receipt of this root and instance, or undefined when the file is missing, malformed or another's. */
async function parseReceipt(candidate: string, root: string, instanceId?: string): Promise<LifecycleReceipt | undefined> {
  try {
    const value = JSON.parse(await readFile(candidate, "utf8")) as LifecycleReceipt;
    const [canonicalRoot, receiptRoot, canonicalRuntime] = await Promise.all([realpath(root), realpath(value.root), realpath(value.runtimeDir)]);
    const relativeRuntime = path.relative(canonicalRoot, canonicalRuntime);
    if (value.version === 1 && typeof value.instanceId === "string" && (instanceId === undefined || value.instanceId === instanceId) && receiptRoot === canonicalRoot && relativeRuntime !== "" &&
      !relativeRuntime.startsWith(`..${path.sep}`) && relativeRuntime !== ".." && !path.isAbsolute(relativeRuntime)) return value;
  } catch { /* Not a receipt of this root. */ }
  return undefined;
}

/**
 * The receipt of one runtime's instance. Receipts of earlier releases record
 * no runtime and belong to the default runtime. A receipt at this instance's
 * paths that records another runtime cannot be attributed to either, so it
 * is refused rather than adopted or cleaned up.
 */
export async function readReceipt(config: DevFnConfig, root: string, instanceId: string, runtime: string = DEFAULT_RUNTIME): Promise<LifecycleReceipt | null> {
  const configuredDirectory = await secureRuntimeDirectory(config, root, instanceId).catch(() => undefined);
  const stable = await stableReceiptPath(root, instanceId).catch(() => undefined);
  for (const candidate of [...(stable ? [stable] : []), ...(configuredDirectory ? [path.join(configuredDirectory, "receipt.json")] : [])]) {
    const value = await parseReceipt(candidate, root, instanceId);
    if (!value) continue; // Try the configured legacy receipt next.
    if ((value.runtime ?? DEFAULT_RUNTIME) !== runtime) {
      throw new DevFnError("DEVFN_RUNTIME_INVALID", `Receipt ${candidate} of instance ${instanceId} records runtime ${JSON.stringify(String(value.runtime).slice(0, 64))}, not ${runtime}; DevFn will not guess which runtime owns it. Inspect it, stop what it lists, then remove it.`,
        { instanceId, runtime, recordedRuntime: value.runtime });
    }
    return value;
  }
  return null;
}

/**
 * A runtime of this checkout as its receipt records it. `attributed` is false
 * when the recorded runtime name does not derive the receipt's instance ID:
 * no command selecting that name reaches it, and DevFn will not guess.
 */
export interface RuntimeSummary { runtime: string; instanceId: string; state: LifecycleReceipt["state"]; profile: string; updatedAt: string; attributed: boolean }

/**
 * The runtimes of this manifest root that have a receipt, by runtime name.
 * Only stable receipts are listed (every release since receipts moved there
 * writes one); receipts of another project are skipped.
 */
export async function listRuntimeReceipts(config: DevFnConfig, root: string): Promise<RuntimeSummary[]> {
  const directory = await resolveContainedPath(root, path.join(".devfn", "receipts"), "receipt").catch(() => undefined);
  const names = directory ? await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [] as string[];
    throw error;
  }) : [];
  const runtimes: RuntimeSummary[] = [];
  for (const name of names.filter((item) => /^[0-9a-f]{12}\.json$/.test(item)).sort()) {
    const value = await parseReceipt(path.join(directory!, name), root, name.slice(0, -".json".length));
    if (!value || value.projectId !== config.project.id) continue;
    const runtime = value.runtime ?? DEFAULT_RUNTIME;
    const derived = typeof runtime === "string" ? await resolveInstanceIdentity(config.project.id, root, runtime).then((identity) => identity.instanceId, () => undefined) : undefined;
    runtimes.push({ runtime: String(runtime), instanceId: value.instanceId, state: value.state, profile: value.profile, updatedAt: value.updatedAt, attributed: derived === value.instanceId });
  }
  return runtimes.sort((a, b) => a.runtime < b.runtime ? -1 : a.runtime > b.runtime ? 1 : 0);
}

/**
 * Every receipt of this manifest root by instance with its file, whatever
 * its project or runtime: the stable receipts, then receipts that exist only
 * under the configured runtime directory (earlier releases).
 */
export async function checkoutReceipts(config: DevFnConfig, root: string): Promise<Map<string, { receipt: LifecycleReceipt; file: string }>> {
  const found = new Map<string, { receipt: LifecycleReceipt; file: string }>();
  const directories = [
    { directory: await resolveContainedPath(root, path.join(".devfn", "receipts"), "receipt").catch(() => undefined), file: (name: string) => name, id: (name: string) => /^[0-9a-f]{12}\.json$/.test(name) ? name.slice(0, -5) : undefined },
    { directory: await resolveContainedPath(root, path.join(config.runtimeDir ?? ".devfn", "instances"), "runtimeDir").catch(() => undefined), file: (name: string) => path.join(name, "receipt.json"), id: (name: string) => /^[0-9a-f]{12}$/.test(name) ? name : undefined },
  ];
  for (const { directory, file, id } of directories) {
    if (!directory) continue;
    const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return [] as string[];
      throw error;
    });
    for (const name of names.sort()) {
      const instanceId = id(name);
      if (!instanceId || found.has(instanceId)) continue;
      const candidate = path.join(directory, file(name));
      const value = await parseReceipt(candidate, root, instanceId);
      if (value) found.set(instanceId, { receipt: value, file: candidate });
    }
  }
  return found;
}

/** An environment output path for one runtime: its `{runtime}` token is the runtime name. */
export const runtimeOutputPath = (output: string, runtime: string = DEFAULT_RUNTIME): string => output.replaceAll("{runtime}", runtime);

/**
 * Environment outputs every runtime of the checkout would write to the same
 * file. A named runtime refuses them before any mutation; the default runtime
 * keeps writing them as earlier releases did.
 */
export function sharedEnvironmentOutputs(config: DevFnConfig, runtime: string | undefined): string[] {
  return isNamedRuntime(runtime) ? (config.environmentOutputs ?? []).map((output) => output.path).filter((item) => !item.includes("{runtime}")) : [];
}

async function writeAtomicReceipt(target: string, receipt: LifecycleReceipt): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temp, target);
}

const RUNTIME_ID = /^[0-9a-f]{32}$/;

/**
 * The random identity of the runtime that owns a DevFn state directory, or
 * undefined before a start first records one. It keeps isolated resource
 * namespaces of runtimes with identical checkout paths (devcontainers, CI
 * runners) apart, and stays stable as long as the state directory does.
 */
export async function readRuntimeId(stateDir: string): Promise<string | undefined> {
  let recorded: string;
  try { recorded = (await readFile(path.join(stateDir, "runtime-id"), "utf8")).trim(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  // recordRuntimeId links only a complete, flushed identity into place.
  if (recorded === "") {
    throw new DevFnError("DEVFN_RUNTIME_INVALID", `${path.join(stateDir, "runtime-id")} is empty; DevFn never records a partial identity, so it was truncated outside DevFn. Restore it, or remove it to give isolated resource namespaces new names.`);
  }
  if (!RUNTIME_ID.test(recorded)) {
    throw new DevFnError("DEVFN_RUNTIME_INVALID", `${path.join(stateDir, "runtime-id")} is malformed; restore it, or remove it to give isolated resource namespaces new names.`);
  }
  return recorded;
}

/** A runtime identity for a state directory that has none yet; recordRuntimeId writes it. */
export function newRuntimeId(): string {
  return randomBytes(16).toString("hex");
}

/**
 * Record a runtime identity unless the state directory already has one, and
 * return the recorded one. The identity is written to a private file, flushed
 * and then linked into place, so every reader sees either no identity or a
 * complete one, and the first link wins. There is no fallback for a state
 * directory without hard links: its lifecycle and registry locks link their
 * owner records too (withFileLock), so DevFn state cannot live there at all.
 */
export async function recordRuntimeId(stateDir: string, candidate: string): Promise<string> {
  const target = path.join(stateDir, "runtime-id");
  const temp = path.join(stateDir, `runtime-id.${randomUUID()}.tmp`);
  try {
    const file = await open(temp, "wx", 0o600);
    try {
      await file.writeFile(`${candidate}\n`, "utf8");
      await file.sync();
    } finally { await file.close(); }
    await link(temp, target);
    return candidate;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "ENOTSUP" || code === "EOPNOTSUPP" || code === "EXDEV" || code === "ENOSYS") {
      throw new DevFnError("DEVFN_RUNTIME_INVALID", `State directory ${stateDir} does not support hard links (${code}), which DevFn state files and locks require; choose a state directory on a local filesystem with --state-dir.`);
    }
    if (code !== "EEXIST") throw error;
  } finally { await unlink(temp).catch(() => undefined); }
  const recorded = await readRuntimeId(stateDir);
  if (!recorded) throw new DevFnError("DEVFN_RUNTIME_INVALID", `${target} could not be read.`);
  return recorded;
}

export async function writeReceipt(receipt: LifecycleReceipt): Promise<void> {
  const runtimeTarget = path.join(receipt.runtimeDir, "receipt.json");
  const stableTarget = await stableReceiptPath(receipt.root, receipt.instanceId);
  await writeAtomicReceipt(stableTarget, receipt);
  if (stableTarget !== runtimeTarget) await writeAtomicReceipt(runtimeTarget, receipt);
}

function dotenv(value: string): string { return /^[A-Za-z0-9_./:@-]*$/.test(value) ? value : JSON.stringify(value); }

/**
 * Write the environment outputs, or runtime.env in the instance's runtime
 * directory when none are declared. `write` writes a declared output (the
 * output claim attributes it); `written` collects each path as soon as it is
 * written, so a failure partway still records the files that exist.
 */
export async function writeEnvironmentOutputs(root: string, runtimeDir: string, outputs: readonly EnvironmentOutput[], environment: Record<string, string>, runtime: string = DEFAULT_RUNTIME,
  options: { write?: (target: string, content: string, mode: number) => Promise<void>; written?: string[] } = {}): Promise<string[]> {
  const effective = outputs.length
    ? await Promise.all(outputs.map(async (output) => ({ output, target: await resolveContainedPath(root, runtimeOutputPath(output.path, runtime), "environmentOutputs.path"), declared: true })))
    : [{ output: { path: "runtime.env", format: "dotenv" as const, mode: 0o600 }, target: path.join(runtimeDir, "runtime.env"), declared: false }];
  const written = options.written ?? [];
  const ordered = Object.entries(environment).sort(([a], [b]) => {
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  });
  for (const { output, target, declared } of effective) {
    const content = output.format === "json"
      ? JSON.stringify(Object.fromEntries(ordered), null, 2) + "\n"
      : ordered.map(([key, value]) => `${key}=${dotenv(value)}`).join("\n") + "\n";
    const mode = output.mode ?? 0o600;
    if (declared && options.write) await options.write(target, content, mode);
    else {
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, content, { encoding: "utf8", mode });
      await chmod(target, mode);
    }
    written.push(target);
  }
  return written;
}
