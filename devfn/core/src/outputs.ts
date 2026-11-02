import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, readdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { processBirthSignature, processIdentityStatus, resolveContainedPath, type DevFnConfig } from "@devfn/config";
import { withFileLock } from "@devfn/ports";

import { DEFAULT_RUNTIME, isNamedRuntime, resolveInstanceIdentity } from "./identity.js";
import { checkoutReceipts, runtimeOutputPath } from "./runtime.js";
import { DevFnError, type InstanceIdentity, type LifecycleReceipt } from "./types.js";

/**
 * The environment-output files one instance of a checkout claims and has
 * written, as canonical paths. `targets` are held while the DevFn process
 * that claimed them runs or the instance's receipt is not stopped; down
 * empties them. `written` remembers every file the instance wrote, so a
 * named runtime keeps rewriting its own files and no one else's. `pending`
 * records a file a named runtime is about to create with the digest of its
 * content, before the file can exist: an interrupted write leaves either no
 * file, a file with that content (its own), or someone else's file.
 */
interface PendingOutput { target: string; sha256: string }

interface OutputClaim {
  version: 1;
  instanceId: string;
  runtime: string;
  targets: string[];
  written: string[];
  pending?: PendingOutput[];
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
    const pending = value.pending === undefined || (Array.isArray(value.pending) &&
      value.pending.every((item) => typeof item?.target === "string" && typeof item.sha256 === "string" && /^[0-9a-f]{64}$/.test(item.sha256)));
    if (value.version === 1 && value.instanceId === instanceId && typeof value.runtime === "string" && strings(value.targets) && strings(value.written) && pending &&
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

async function removeClaim(root: string, instanceId: string): Promise<void> {
  await unlink(path.join(await claimDirectory(root), `${instanceId}.json`)).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
}

async function canonicalKeys(paths: readonly string[] | undefined): Promise<Set<string>> {
  const keys = new Set<string>();
  for (const item of paths ?? []) keys.add(pathKey((await canonicalTarget(item)).canonical));
  return keys;
}

const digest = (content: string | Buffer): string => createHash("sha256").update(content).digest("hex");

/** Whether a pending file is the one this instance was creating: a regular file holding the recorded content. */
async function pendingIsOwn(item: PendingOutput): Promise<boolean> {
  if (!(await lstat(item.target).catch(() => undefined))?.isFile()) return false;
  const content = await readFile(item.target).catch(() => undefined);
  return content !== undefined && digest(content) === item.sha256;
}

/** The files an instance wrote: its written history and any interrupted creation that provably produced its own file. */
async function writtenByClaim(claim: OutputClaim | undefined): Promise<string[]> {
  if (!claim) return [];
  const adopted: string[] = [];
  for (const item of claim.pending ?? []) if (await pendingIsOwn(item)) adopted.push(item.target);
  return [...new Set([...claim.written, ...adopted])].sort();
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
 * How to stop the owner of a receipt. A receipt this manifest cannot select
 * (another project ID, or a runtime name that does not derive its instance)
 * is named with what it records, since devfn down cannot reach it.
 */
async function ownerRemedy(config: DevFnConfig, root: string, instanceId: string, entry: { receipt: LifecycleReceipt; file: string } | undefined, runtime: string): Promise<string> {
  const flag = runtime === DEFAULT_RUNTIME ? "" : ` --runtime ${runtime}`;
  if (!entry) return "wait for the DevFn command that claimed it to finish";
  const projectId = String(entry.receipt.projectId);
  const reachable = projectId === config.project.id &&
    await resolveInstanceIdentity(config.project.id, root, runtime).then((identity) => identity.instanceId === instanceId, () => false);
  if (reachable) return `stop it with devfn down${flag} first`;
  return `its receipt ${entry.file} records project ${JSON.stringify(projectId.slice(0, 64))} and runtime ${JSON.stringify(runtime.slice(0, 64))}, which this manifest cannot select; set project.id back to ${JSON.stringify(projectId.slice(0, 64))} and run devfn down${flag}, or, once nothing that receipt lists runs, remove it`;
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
    const entry = receipts.get(instanceId);
    const receipt = entry?.receipt;
    const owner = { runtime: claim?.runtime ?? String(receipt?.runtime ?? DEFAULT_RUNTIME), instanceId, ...(entry ? { receipt: entry.file, projectId: String(entry.receipt.projectId) } : {}) };
    const held = new Set<string>();
    if (claim?.targets.length && (live(receipt) || await claimantRuns(claim))) for (const key of await canonicalKeys(claim.targets)) held.add(key);
    if (live(receipt)) {
      // A live receipt of an earlier release records what it wrote only once
      // it wrote it; without that or a claim its files cannot be known.
      if (!claim && !receipt!.environmentOutputs?.length) {
        throw new DevFnError("DEVFN_RUNTIME_INVALID", `Runtime ${owner.runtime} (instance ${instanceId}) has a ${receipt!.state} receipt that records no environment outputs, so DevFn cannot tell whether it owns ${targets.map((item) => relativeName(root, item.target)).join(", ")}; ${await ownerRemedy(config, root, instanceId, entry, owner.runtime)}.`,
          { runtime, owner });
      }
      for (const key of await canonicalKeys(receipt!.environmentOutputs)) held.add(key);
    }
    const taken = [...held].map((key) => wanted.get(key)).find((item) => item !== undefined);
    if (taken) {
      throw new DevFnError("DEVFN_RUNTIME_INVALID", `Environment output ${relativeName(root, taken.target)} of runtime ${runtime} is the file runtime ${owner.runtime} (instance ${instanceId}) writes; give the outputs distinct names, or ${await ownerRemedy(config, root, instanceId, entry, owner.runtime)}.`,
        { runtime, target: taken.canonical, owner });
    }
  }
  if (!isNamedRuntime(identity.runtime)) return;
  // Its claim record is the only attribution: every named runtime has one, and a write records each file in it.
  const written = new Set((await writtenByClaim(claims.get(identity.instanceId)?.claim)).map(pathKey));
  for (const item of targets) {
    if (item.symlink) throw symlinkRefusal(root, runtime, item.target);
    if (item.exists && !written.has(item.key)) {
      throw new DevFnError("DEVFN_RUNTIME_INVALID", `Environment output ${relativeName(root, item.target)} of runtime ${runtime} already exists and runtime ${runtime} did not write it; move it away or rename the output.`,
        { runtime, target: item.canonical });
    }
  }
}

const symlinkRefusal = (root: string, runtime: string, target: string) => new DevFnError("DEVFN_RUNTIME_INVALID",
  `Environment output ${relativeName(root, target)} of runtime ${runtime} is a symlink; a named runtime writes only its own regular files.`, { runtime, target });

/** What up refuses for this runtime's environment outputs, checked without claiming them (preflight and doctor). */
export async function assertEnvironmentOutputsAvailable(config: DevFnConfig, root: string, identity: InstanceIdentity): Promise<void> {
  const targets = await selectedTargets(config, root, identity.runtime ?? DEFAULT_RUNTIME);
  if (targets.length) await assertTargetsAvailable(config, root, identity, targets, await readClaims(root));
}

export interface EnvironmentOutputClaim {
  /** Hand the claim to the lifecycle receipt about to be written; restore() then keeps it. */
  commit(): Promise<void>;
  /** Give back the targets of a claim no receipt took over; the files written stay this instance's. */
  restore(): Promise<void>;
  /** Write one claimed environment output, attributing it to this instance no later than it exists. */
  write(target: string, content: string, mode: number): Promise<void>;
}

const LINKLESS = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV"]);

/**
 * Create a file that must not exist yet, complete or not at all, without
 * following a link at its name: a private temporary file is flushed, then
 * hard-linked into place, which fails if anything exists there. Without hard
 * links, an exclusive no-follow open creates it.
 */
async function createExclusive(target: string, content: string, mode: number): Promise<"created" | "exists"> {
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.devfn-tmp`);
  try {
    const file = await open(temp, "wx", mode);
    try { await file.writeFile(content, "utf8"); await file.chmod(mode); await file.sync(); } finally { await file.close(); }
    await link(temp, target);
    return "created";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return "exists";
    if (!code || !LINKLESS.has(code)) throw error;
  } finally { await unlink(temp).catch(() => undefined); }
  let file;
  try { file = await open(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), mode); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return "exists";
    throw error;
  }
  try { await file.writeFile(content, "utf8"); await file.chmod(mode); await file.sync(); } finally { await file.close(); }
  return "created";
}

/** Replace a regular file in place of a link-free path: write a private temporary file, then rename it over the target. */
async function replaceRegular(target: string, content: string, mode: number): Promise<void> {
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.devfn-tmp`);
  try {
    const file = await open(temp, "wx", mode);
    try { await file.writeFile(content, "utf8"); await file.chmod(mode); await file.sync(); } finally { await file.close(); }
    await rename(temp, target);
  } finally { await unlink(temp).catch(() => undefined); }
}

/**
 * Claim this instance's environment outputs under the checkout-wide output
 * lock, before any lease, receipt or process exists, so concurrent starts of
 * runtimes whose outputs coincide are arbitrated: the first claim wins.
 */
export async function claimEnvironmentOutputs(config: DevFnConfig, root: string, identity: InstanceIdentity): Promise<EnvironmentOutputClaim> {
  const runtime = identity.runtime ?? DEFAULT_RUNTIME;
  let previous: OutputClaim | undefined;
  let hadPrevious = false;
  let claim!: OutputClaim;
  const record = async (targets: readonly Target[]) => {
    const text = await readOwnClaim(root, identity.instanceId);
    hadPrevious = text !== undefined;
    previous = text === undefined ? undefined : parseClaim(text, identity.instanceId);
    // An interrupted creation is this instance's only if it left exactly the content it recorded.
    claim = { version: 1, instanceId: identity.instanceId, runtime, targets: targets.map((item) => item.canonical), written: await writtenByClaim(previous),
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
  const claimed = new Set(targets.length ? claim.targets.map(pathKey) : []);
  const update = async (change: (current: OutputClaim) => OutputClaim) => {
    claim = change(claim);
    await writeClaim(root, claim);
  };
  let committed = false;
  return {
    // Every committed start records a claim, also of no file, so a live
    // receipt without one is known to come from an earlier release.
    commit: async () => {
      if (!targets.length) await record([]);
      committed = true;
    },
    restore: async () => {
      if (committed || !targets.length) return;
      const { pending: _stale, ...base } = previous ?? claim;
      const kept: OutputClaim = { ...base, targets: previous?.targets ?? [], written: claim.written, ...(claim.pending?.length ? { pending: claim.pending } : {}) };
      if (!hadPrevious && !kept.written.length && !kept.pending?.length) await removeClaim(root, identity.instanceId);
      else await writeClaim(root, kept);
    },
    write: async (target, content, mode) => {
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      if (!isNamedRuntime(identity.runtime)) {
        // The default runtime writes its outputs as DevFn v0.1 did.
        await writeFile(target, content, { encoding: "utf8", mode });
        await chmod(target, mode);
        const { canonical } = await canonicalTarget(target);
        if (!claim || claim.written.includes(canonical)) return;
        await update((current) => ({ ...current, written: [...new Set([...current.written, canonical])].sort() }));
        return;
      }
      // A named runtime writes at the canonical path it claimed, never through
      // a symlink, and creates only a file nothing else created in between.
      const resolved = await canonicalTarget(target);
      if (resolved.symlink) throw symlinkRefusal(root, runtime, target);
      if (!claimed.has(pathKey(resolved.canonical))) {
        throw new DevFnError("DEVFN_RUNTIME_INVALID", `Environment output ${relativeName(root, target)} of runtime ${runtime} now resolves to ${resolved.canonical}, not the file it claimed; a directory on its path changed during startup.`,
          { runtime, target: resolved.canonical });
      }
      const canonical = resolved.canonical;
      const recorded = claim.written.some((item) => pathKey(item) === pathKey(canonical));
      const stat = recorded ? await lstat(canonical).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; }) : undefined;
      if (stat) {
        if (stat.isSymbolicLink()) throw symlinkRefusal(root, runtime, target);
        if (!stat.isFile()) {
          throw new DevFnError("DEVFN_RUNTIME_INVALID", `Environment output ${relativeName(root, target)} of runtime ${runtime} is no longer a regular file; DevFn will not replace it.`, { runtime, target: canonical });
        }
        await replaceRegular(canonical, content, mode);
        return;
      }
      const intent: PendingOutput = { target: canonical, sha256: digest(content) };
      await update((current) => ({ ...current, pending: [...(current.pending ?? []).filter((item) => item.target !== canonical), intent] }));
      const outcome = await createExclusive(canonical, content, mode);
      await update((current) => {
        const pending = (current.pending ?? []).filter((item) => item.target !== canonical);
        const { pending: _dropped, ...rest } = current;
        return { ...rest, ...(pending.length ? { pending } : {}), written: outcome === "created" ? [...new Set([...current.written, canonical])].sort() : current.written };
      });
      if (outcome === "exists") {
        throw new DevFnError("DEVFN_RUNTIME_INVALID", `Environment output ${relativeName(root, target)} of runtime ${runtime} was created by someone else after DevFn claimed it; DevFn left it untouched. Move it away or rename the output.`,
          { runtime, target: canonical });
      }
    },
  };
}

/** Release a stopped instance's claim; the files it wrote stay its own. */
export async function releaseEnvironmentOutputs(root: string, instanceId: string): Promise<void> {
  const text = await readOwnClaim(root, instanceId);
  const current = text === undefined ? undefined : parseClaim(text, instanceId);
  if (current?.targets.length) await writeClaim(root, { ...current, targets: [] });
}
