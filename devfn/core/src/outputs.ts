import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
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
 * empties them. `written` remembers every file the instance wrote with the
 * digest of what it last wrote there, so a named runtime keeps rewriting its
 * own unchanged files and no one else's. `pending` records a file a named
 * runtime is about to create or replace with the digest of its new content,
 * before any of it can reach the file: an interrupted write leaves no file,
 * the content it last wrote or the content it intended (both its own), or
 * someone else's file.
 */
interface WrittenOutput { target: string; sha256: string }

interface OutputClaim {
  version: 1;
  instanceId: string;
  runtime: string;
  targets: string[];
  written: WrittenOutput[];
  pending?: WrittenOutput[];
  pid: number;
  birthSignature?: string;
  createdAt: string;
}

const CLAIMS = path.join(".devfn", "outputs");
const CLAIMS_LOCK = "claims.lock";
// The lock guards a few file operations, so a holder verified dead (pid and
// birth signature) is recovered well within a waiter's budget: a crashed
// runtime never holds up another runtime's start. A live holder is never
// taken over however long it holds the lock.
const CLAIMS_LOCK_TIMEOUT_MS = 30_000;
const CLAIMS_LOCK_STALE_MS = 5_000;
const INSTANCE_ID = /^[0-9a-f]{12}$/;

/** Paths compare case-folded where the default filesystems fold case. */
const pathKey = (value: string): string => process.platform === "darwin" || process.platform === "win32" ? value.toLowerCase() : value;

const relativeName = (root: string, target: string): string => path.relative(root, target) || target;

/**
 * A DevFn staging file of an output, `.<file name>.<uuid>.devfn-tmp` beside
 * it: the file name it stages, or undefined for any other name.
 */
const STAGING = /^\.(.+)\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.devfn-tmp$/;
export const stagedOutputName = (name: string): string | undefined => STAGING.exec(name)?.[1];
const stagingPath = (target: string): string => path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.devfn-tmp`);

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
    const files = (items: unknown) => Array.isArray(items) &&
      items.every((item: WrittenOutput) => typeof item?.target === "string" && typeof item.sha256 === "string" && /^[0-9a-f]{64}$/.test(item.sha256));
    if (value.version === 1 && value.instanceId === instanceId && typeof value.runtime === "string" && strings(value.targets) && files(value.written) &&
      (value.pending === undefined || files(value.pending)) &&
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

/** Whether a file is a regular file holding exactly the content recorded for it. */
async function holdsRecorded(item: WrittenOutput): Promise<boolean> {
  if (!(await lstat(item.target).catch(() => undefined))?.isFile()) return false;
  const content = await readFile(item.target).catch(() => undefined);
  return content !== undefined && digest(content) === item.sha256;
}

/** Record one written file, replacing an earlier record of the same path. */
const withWritten = (written: readonly WrittenOutput[], item: WrittenOutput): WrittenOutput[] =>
  [...written.filter((entry) => pathKey(entry.target) !== pathKey(item.target)), item].sort((a, b) => a.target < b.target ? -1 : a.target > b.target ? 1 : 0);

/** The files an instance wrote: its written history and any interrupted creation or replacement that provably left its intended content. */
async function writtenByClaim(claim: OutputClaim | undefined): Promise<WrittenOutput[]> {
  if (!claim) return [];
  let written = [...claim.written];
  for (const item of claim.pending ?? []) if (await holdsRecorded(item)) written = withWritten(written, item);
  return written;
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
  const written = new Map((await writtenByClaim(claims.get(identity.instanceId)?.claim)).map((item) => [pathKey(item.target), item]));
  for (const item of targets) {
    if (item.symlink) throw symlinkRefusal(root, runtime, item.target);
    if (!item.exists) continue;
    const own = written.get(item.key);
    if (!own) {
      throw new DevFnError("DEVFN_RUNTIME_INVALID", `Environment output ${relativeName(root, item.target)} of runtime ${runtime} already exists and runtime ${runtime} did not write it; move it away or rename the output.`,
        { runtime, target: item.canonical });
    }
    if (!(await holdsRecorded({ target: item.canonical, sha256: own.sha256 }))) throw changedRefusal(root, runtime, item.target, item.canonical);
  }
}

const changedRefusal = (root: string, runtime: string, target: string, canonical: string) => new DevFnError("DEVFN_RUNTIME_INVALID",
  `Environment output ${relativeName(root, target)} of runtime ${runtime} changed since runtime ${runtime} wrote it; DevFn left it untouched. Move it away, or restore what DevFn wrote, before starting it again.`,
  { runtime, target: canonical });

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
  const temp = stagingPath(target);
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
  const temp = stagingPath(target);
  try {
    const file = await open(temp, "wx", mode);
    try { await file.writeFile(content, "utf8"); await file.chmod(mode); await file.sync(); } finally { await file.close(); }
    await rename(temp, target);
  } finally { await unlink(temp).catch(() => undefined); }
}

/**
 * Write a file in place as DevFn v0.1 did (truncate, keep its inode, apply
 * the mode), without following a link at its name: a symlink there fails.
 */
async function overwriteInPlace(target: string, content: string, mode: number): Promise<"written" | "symlink"> {
  let file;
  try { file = await open(target, constants.O_CREAT | constants.O_TRUNC | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), mode); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "EMLINK") return "symlink";
    throw error;
  }
  try { await file.writeFile(content, "utf8"); await file.chmod(mode); } finally { await file.close(); }
  return "written";
}

/** Remove staging files an interrupted write left beside claimed targets; only the claimant writes there. */
async function removeOrphanedStaging(targets: readonly Target[]): Promise<void> {
  for (const item of targets) {
    const names = await readdir(path.dirname(item.canonical)).catch(() => [] as string[]);
    for (const name of names) {
      const staged = stagedOutputName(name);
      if (staged !== undefined && pathKey(staged) === pathKey(path.basename(item.canonical))) await unlink(path.join(path.dirname(item.canonical), name)).catch(() => undefined);
    }
  }
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
    // The lock lives among the claims, which are never task inputs, and so
    // do the directories it is retired to on release.
    const directory = await claimDirectory(root);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await withFileLock(path.join(directory, CLAIMS_LOCK), async () => {
      const locked = await selectedTargets(config, root, runtime);
      await assertTargetsAvailable(config, root, identity, locked, await readClaims(root));
      await record(locked);
      await removeOrphanedStaging(locked);
    }, { timeoutMs: CLAIMS_LOCK_TIMEOUT_MS, staleMs: CLAIMS_LOCK_STALE_MS });
  }
  const update = async (change: (current: OutputClaim) => OutputClaim) => {
    claim = change(claim);
    await writeClaim(root, claim);
  };
  /** Record the content about to be written before any byte of it can reach the file. */
  const intend = async (intent: WrittenOutput) =>
    await update((current) => ({ ...current, pending: [...(current.pending ?? []).filter((item) => pathKey(item.target) !== pathKey(intent.target)), intent] }));
  /** Clear the intent, recording the content as written when it landed. */
  const settle = async (intent: WrittenOutput, landed: boolean) => await update((current) => {
    const pending = (current.pending ?? []).filter((item) => pathKey(item.target) !== pathKey(intent.target));
    const { pending: _dropped, ...rest } = current;
    return { ...rest, ...(pending.length ? { pending } : {}), written: landed ? withWritten(current.written, intent) : current.written };
  });
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
      // Every runtime writes only the canonical file it claimed: a target a
      // changed symlink or directory now leads elsewhere is refused before any
      // byte changes, and the claimed path is written without following a
      // link at its name. (A directory swapped in the instant between the last
      // check and the open is not detected.)
      const named = isNamedRuntime(identity.runtime);
      const sha256 = digest(content);
      const claimedPath = async (): Promise<string> => {
        const resolved = await canonicalTarget(target);
        if (named && resolved.symlink) throw symlinkRefusal(root, runtime, target);
        const key = pathKey(resolved.canonical);
        const match = claim?.targets.find((item) => pathKey(item) === key);
        if (match === undefined) {
          throw new DevFnError("DEVFN_RUNTIME_INVALID", `Environment output ${relativeName(root, target)} of runtime ${runtime} now resolves to ${resolved.canonical}, not the file it claimed; a symlink or directory on its path changed during startup, and DevFn left every file untouched.`,
            { runtime, target: resolved.canonical });
        }
        return match;
      };
      let canonical = await claimedPath();
      try {
        await mkdir(path.dirname(canonical), { recursive: true, mode: 0o700 });
        canonical = await claimedPath();
        if (!named) {
          // The default runtime overwrites its claimed file in place as DevFn v0.1 did.
          if (await overwriteInPlace(canonical, content, mode) === "symlink") {
            throw new DevFnError("DEVFN_RUNTIME_INVALID", `Environment output ${relativeName(root, target)} of runtime ${runtime} became a symlink after DevFn claimed it; DevFn left it untouched.`, { runtime, target: canonical });
          }
          await update((current) => ({ ...current, written: withWritten(current.written, { target: canonical, sha256 }) }));
          return;
        }
        // A named runtime replaces only a regular file it wrote and nobody changed since, and creates only a file nothing else created in between.
        const intent: WrittenOutput = { target: canonical, sha256 };
        const own = claim.written.find((item) => pathKey(item.target) === pathKey(canonical));
        const stat = own ? await lstat(canonical).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; }) : undefined;
        if (own && stat) {
          if (stat.isSymbolicLink()) throw symlinkRefusal(root, runtime, target);
          if (!stat.isFile()) {
            throw new DevFnError("DEVFN_RUNTIME_INVALID", `Environment output ${relativeName(root, target)} of runtime ${runtime} is no longer a regular file; DevFn will not replace it.`, { runtime, target: canonical });
          }
          if (!(await holdsRecorded(own))) throw changedRefusal(root, runtime, target, canonical);
          // The new content is recorded before the rename can land, so an
          // interruption leaves the old or the new content, both its own.
          await intend(intent);
          await replaceRegular(canonical, content, mode);
          await settle(intent, true);
          return;
        }
        await intend(intent);
        const outcome = await createExclusive(canonical, content, mode);
        await settle(intent, outcome === "created");
        if (outcome === "exists") {
          throw new DevFnError("DEVFN_RUNTIME_INVALID", `Environment output ${relativeName(root, target)} of runtime ${runtime} was created by someone else after DevFn claimed it; DevFn left it untouched. Move it away or rename the output.`,
            { runtime, target: canonical });
        }
      } catch (error) {
        if (error instanceof DevFnError) throw error;
        // Name the output, not only the staging file an I/O error reports.
        const failure = error as NodeJS.ErrnoException;
        throw Object.assign(new Error(`Could not write environment output ${relativeName(root, target)}: ${failure.message ?? String(error)}`, { cause: error }), failure.code ? { code: failure.code } : {});
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
