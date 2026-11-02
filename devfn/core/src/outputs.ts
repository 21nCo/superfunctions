import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { processBirthSignature, processIdentityStatus, resolveContainedPath, type DevFnConfig } from "@devfn/config";
import { withFileLock } from "@devfn/ports";

import { DEFAULT_RUNTIME, isNamedRuntime } from "./identity.js";
import { checkoutReceipts, runtimeOutputPath } from "./runtime.js";
import { DevFnError, type InstanceIdentity, type LifecycleReceipt } from "./types.js";

/**
 * The environment-output files one instance of a checkout claims and has
 * written, as canonical paths. `targets` are held while the DevFn process
 * that claimed them runs or the instance's receipt is not stopped; down
 * empties them. `written` remembers every file the instance wrote, so a
 * named runtime keeps rewriting its own files and no one else's.
 */
interface OutputClaim {
  version: 1;
  instanceId: string;
  runtime: string;
  targets: string[];
  written: string[];
  pid: number;
  birthSignature?: string;
  createdAt: string;
}

const CLAIMS = path.join(".devfn", "outputs");
const INSTANCE_ID = /^[0-9a-f]{12}$/;

/** Paths compare case-folded where the default filesystems fold case. */
const pathKey = (value: string): string => process.platform === "darwin" || process.platform === "win32" ? value.toLowerCase() : value;

const relativeName = (root: string, target: string): string => path.relative(root, target) || target;

/**
 * The file a write to target reaches: a symlink's target, otherwise the
 * realpath of its nearest existing directory joined with the rest.
 */
async function canonicalTarget(target: string): Promise<{ canonical: string; exists: boolean; symlink: boolean }> {
  const stat = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined;
    throw error;
  });
  if (stat?.isSymbolicLink()) {
    const resolved = await realpath(target).catch(() => undefined);
    return { canonical: resolved ?? path.resolve(target), exists: resolved !== undefined, symlink: true };
  }
  const rest = [path.basename(target)];
  let directory = path.dirname(target);
  for (;;) {
    try { return { canonical: path.join(await realpath(directory), ...rest), exists: stat !== undefined, symlink: false }; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const parent = path.dirname(directory);
      if ((code !== "ENOENT" && code !== "ENOTDIR") || parent === directory) throw error;
      rest.unshift(path.basename(directory));
      directory = parent;
    }
  }
}

async function claimDirectory(root: string): Promise<string> {
  return await resolveContainedPath(root, CLAIMS, "environmentOutputs");
}

function parseClaim(text: string, instanceId: string): OutputClaim | undefined {
  try {
    const value = JSON.parse(text) as OutputClaim;
    const strings = (items: unknown) => Array.isArray(items) && items.every((item) => typeof item === "string");
    if (value.version === 1 && value.instanceId === instanceId && typeof value.runtime === "string" && strings(value.targets) && strings(value.written) &&
      Number.isSafeInteger(value.pid) && value.pid > 0 && typeof value.createdAt === "string") return value;
  } catch { /* Malformed below. */ }
  return undefined;
}

/** Claim records of the checkout by instance; a malformed record cannot be attributed and is refused. */
async function readClaims(root: string): Promise<Map<string, { claim: OutputClaim; text: string }>> {
  const directory = await claimDirectory(root);
  const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [] as string[];
    throw error;
  });
  const claims = new Map<string, { claim: OutputClaim; text: string }>();
  for (const name of names) {
    const instanceId = name.endsWith(".json") ? name.slice(0, -5) : "";
    if (!INSTANCE_ID.test(instanceId)) continue;
    const text = await readFile(path.join(directory, name), "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (text === undefined) continue;
    const claim = parseClaim(text, instanceId);
    if (!claim) {
      throw new DevFnError("DEVFN_RUNTIME_INVALID", `Environment-output claim ${path.join(directory, name)} is malformed, so DevFn cannot tell which files instance ${instanceId} owns; stop that runtime with devfn down, then remove the file.`,
        { instanceId, claim: path.join(directory, name) });
    }
    claims.set(instanceId, { claim, text });
  }
  return claims;
}

async function readOwnClaim(root: string, instanceId: string): Promise<string | undefined> {
  return await readFile(path.join(await claimDirectory(root), `${instanceId}.json`), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
}

async function writeClaim(root: string, claim: OutputClaim): Promise<void> {
  const directory = await claimDirectory(root);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = path.join(directory, `${claim.instanceId}.json`);
  const temp = `${target}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(claim, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temp, target);
}

async function restoreClaim(root: string, instanceId: string, text: string | undefined): Promise<void> {
  const directory = await claimDirectory(root);
  const target = path.join(directory, `${instanceId}.json`);
  if (text === undefined) { await unlink(target).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; }); return; }
  const temp = `${target}.${randomUUID()}.tmp`;
  await writeFile(temp, text, { encoding: "utf8", mode: 0o600 });
  await rename(temp, target);
}

async function canonicalKeys(paths: readonly string[] | undefined): Promise<Set<string>> {
  const keys = new Set<string>();
  for (const item of paths ?? []) keys.add(pathKey((await canonicalTarget(item)).canonical));
  return keys;
}

const live = (receipt: LifecycleReceipt | undefined): boolean => receipt !== undefined && receipt.state !== "stopped";

async function claimantRuns(claim: OutputClaim): Promise<boolean> {
  const status = await processIdentityStatus(claim.pid, claim.birthSignature, claim.createdAt);
  return status !== "exited" && status !== "identity-mismatch";
}

interface Target { output: string; target: string; canonical: string; key: string; exists: boolean; symlink: boolean }

async function selectedTargets(config: DevFnConfig, root: string, runtime: string): Promise<Target[]> {
  const targets: Target[] = [];
  for (const output of config.environmentOutputs ?? []) {
    const target = await resolveContainedPath(root, runtimeOutputPath(output.path, runtime), "environmentOutputs.path");
    const resolved = await canonicalTarget(target);
    targets.push({ output: output.path, target, ...resolved, key: pathKey(resolved.canonical) });
  }
  return targets;
}

/**
 * Refuse environment outputs this instance may not write: a file another
 * instance of the checkout holds, any file while another instance's claims
 * cannot be known, and for a named runtime a symlink or an existing file this
 * instance never wrote. The default runtime keeps writing its own outputs
 * over existing files as earlier releases did.
 */
async function assertTargetsAvailable(config: DevFnConfig, root: string, identity: InstanceIdentity, targets: readonly Target[],
  claims: Map<string, { claim: OutputClaim; text: string }>): Promise<void> {
  if (!targets.length) return;
  const runtime = identity.runtime ?? DEFAULT_RUNTIME;
  const receipts = await checkoutReceipts(config, root);
  const wanted = new Map(targets.map((item) => [item.key, item]));
  for (const instanceId of new Set([...claims.keys(), ...receipts.keys()])) {
    if (instanceId === identity.instanceId) continue;
    const claim = claims.get(instanceId)?.claim;
    const receipt = receipts.get(instanceId);
    const owner = { runtime: claim?.runtime ?? String(receipt?.runtime ?? DEFAULT_RUNTIME), instanceId };
    const held = new Set<string>();
    if (claim?.targets.length && (live(receipt) || await claimantRuns(claim))) for (const key of await canonicalKeys(claim.targets)) held.add(key);
    if (live(receipt)) {
      // A live receipt of an earlier release records what it wrote only once
      // it wrote it; without that or a claim its files cannot be known.
      if (!claim && !receipt!.environmentOutputs?.length) {
        throw new DevFnError("DEVFN_RUNTIME_INVALID", `Runtime ${owner.runtime} (instance ${instanceId}) has a ${receipt!.state} receipt that records no environment outputs, so DevFn cannot tell whether it owns ${targets.map((item) => relativeName(root, item.target)).join(", ")}; stop it with devfn down${owner.runtime === DEFAULT_RUNTIME ? "" : ` --runtime ${owner.runtime}`} first.`,
          { runtime, owner });
      }
      for (const key of await canonicalKeys(receipt!.environmentOutputs)) held.add(key);
    }
    const taken = [...held].map((key) => wanted.get(key)).find((item) => item !== undefined);
    if (taken) {
      throw new DevFnError("DEVFN_RUNTIME_INVALID", `Environment output ${relativeName(root, taken.target)} of runtime ${runtime} is the file runtime ${owner.runtime} (instance ${instanceId}) writes; give the outputs distinct names or stop that runtime first.`,
        { runtime, target: taken.canonical, owner });
    }
  }
  if (!isNamedRuntime(identity.runtime)) return;
  const own = claims.get(identity.instanceId)?.claim;
  const written = await canonicalKeys([...own?.written ?? [], ...receipts.get(identity.instanceId)?.environmentOutputs ?? []]);
  for (const item of targets) {
    if (item.symlink) {
      throw new DevFnError("DEVFN_RUNTIME_INVALID", `Environment output ${relativeName(root, item.target)} of runtime ${runtime} is a symlink; a named runtime writes only its own regular files.`,
        { runtime, target: item.target });
    }
    if (item.exists && !written.has(item.key)) {
      throw new DevFnError("DEVFN_RUNTIME_INVALID", `Environment output ${relativeName(root, item.target)} of runtime ${runtime} already exists and runtime ${runtime} did not write it; move it away or rename the output.`,
        { runtime, target: item.canonical });
    }
  }
}

/** What up refuses for this runtime's environment outputs, checked without claiming them (preflight and doctor). */
export async function assertEnvironmentOutputsAvailable(config: DevFnConfig, root: string, identity: InstanceIdentity): Promise<void> {
  const targets = await selectedTargets(config, root, identity.runtime ?? DEFAULT_RUNTIME);
  if (targets.length) await assertTargetsAvailable(config, root, identity, targets, await readClaims(root));
}

export interface EnvironmentOutputClaim {
  /** Hand the claim to the lifecycle receipt about to be written; restore() then keeps it. */
  commit(): Promise<void>;
  /** Undo a claim no receipt took over. */
  restore(): Promise<void>;
  /** Remember files the instance wrote. */
  recordWritten(paths: readonly string[]): Promise<void>;
}

/**
 * Claim this instance's environment outputs under the checkout-wide output
 * lock, before any lease, receipt or process exists, so concurrent starts of
 * runtimes whose outputs coincide are arbitrated: the first claim wins.
 */
export async function claimEnvironmentOutputs(config: DevFnConfig, root: string, identity: InstanceIdentity): Promise<EnvironmentOutputClaim> {
  const runtime = identity.runtime ?? DEFAULT_RUNTIME;
  let previous: string | undefined;
  let claim!: OutputClaim;
  const record = async (targets: readonly Target[]) => {
    previous = await readOwnClaim(root, identity.instanceId);
    const prior = previous === undefined ? undefined : parseClaim(previous, identity.instanceId);
    claim = { version: 1, instanceId: identity.instanceId, runtime, targets: targets.map((item) => item.canonical), written: prior?.written ?? [],
      pid: process.pid, ...await processBirthSignature(process.pid).then((value) => value ? { birthSignature: value } : {}), createdAt: new Date().toISOString() };
    await writeClaim(root, claim);
  };
  const targets = await selectedTargets(config, root, runtime);
  if (targets.length) {
    const devfn = await resolveContainedPath(root, ".devfn", "environmentOutputs");
    await mkdir(devfn, { recursive: true, mode: 0o700 });
    await withFileLock(path.join(devfn, "outputs.lock"), async () => {
      const locked = await selectedTargets(config, root, runtime);
      await assertTargetsAvailable(config, root, identity, locked, await readClaims(root));
      await record(locked);
    }, { timeoutMs: 30_000 });
  }
  let committed = false;
  const handle: EnvironmentOutputClaim = {
    // Every committed start records a claim, also of no file, so a live
    // receipt without one is known to come from an earlier release.
    commit: async () => {
      if (!targets.length) await record([]);
      committed = true;
    },
    restore: async () => { if (!committed && targets.length) await restoreClaim(root, identity.instanceId, previous); },
    recordWritten: async (paths) => {
      const written = new Set(claim.written);
      for (const item of paths) written.add((await canonicalTarget(item)).canonical);
      claim = { ...claim, written: [...written].sort() };
      await writeClaim(root, claim);
    },
  };
  return handle;
}

/** Release a stopped instance's claim; the files it wrote stay its own. */
export async function releaseEnvironmentOutputs(root: string, instanceId: string): Promise<void> {
  const text = await readOwnClaim(root, instanceId);
  const current = text === undefined ? undefined : parseClaim(text, instanceId);
  if (current?.targets.length) await writeClaim(root, { ...current, targets: [] });
}
