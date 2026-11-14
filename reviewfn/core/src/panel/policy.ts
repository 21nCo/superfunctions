import { execFile } from "node:child_process";
import { devNull } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { stableStringify } from "../canonical.js";
import { ReviewFnError } from "../errors.js";
import { isolatedGitEnvironment } from "../git-environment.js";
import { safeRead } from "../safe-files.js";
import { PANEL_DEFAULT_MAX_CONCURRENT_SLOTS, type PanelPolicy, type PanelSlot } from "./types.js";
import { validatePanelPolicy } from "./validate.js";

const execFileAsync = promisify(execFile);

/** Repository-relative location of the panel policy. */
export const PANEL_POLICY_PATH = ".reviewfn/panel.json";
const MAX_POLICY_BYTES = 1024 * 1024;

/** A valid panel policy, or `REVIEWFN_CONFIG_INVALID` naming every structural issue. */
export function parsePanelPolicy(input: unknown): PanelPolicy {
  const validation = validatePanelPolicy(input);
  if (!validation.valid) {
    const details = validation.issues.map(issue => `${issue.path || "/"} ${issue.message}`).join("; ");
    throw new ReviewFnError("REVIEWFN_CONFIG_INVALID", `Invalid panel policy: ${details}`, { issues: validation.issues });
  }
  return structuredClone(input) as PanelPolicy;
}

export function effectiveMaxConcurrentSlots(policy: PanelPolicy): number {
  return policy.maxConcurrentSlots ?? PANEL_DEFAULT_MAX_CONCURRENT_SLOTS;
}

/** Harness and model pair of a slot within its stage: what a repository may add lenses to. */
function pairKey(slot: PanelSlot): string {
  return stableStringify({ stage: slot.stage, harness: slot.harness, inference: slot.inference });
}

/**
 * Apply a repository copy of the panel policy to the trusted one. The copy may only tighten: raise quorums, add slots
 * with new lenses to a harness and model pair the trusted policy already has in that stage, or lower budgets and
 * concurrency. Trusted slots keep their order, and are listed before added slots. Any other difference is
 * `REVIEWFN_PANEL_POLICY_WEAKENED`, listing every weakening.
 */
export function applyRepositoryPanelPolicy(trustedInput: PanelPolicy, repositoryInput: unknown): PanelPolicy {
  const trusted = parsePanelPolicy(trustedInput);
  const repository = parsePanelPolicy(repositoryInput);
  const reasons: string[] = [];
  for (const stage of ["stage1", "stage2"] as const) {
    if (repository.quorum[stage] < trusted.quorum[stage]) reasons.push(`lowers quorum.${stage} from ${trusted.quorum[stage]} to ${repository.quorum[stage]}`);
  }
  if (effectiveMaxConcurrentSlots(repository) > effectiveMaxConcurrentSlots(trusted)) reasons.push(`raises maxConcurrentSlots from ${effectiveMaxConcurrentSlots(trusted)} to ${effectiveMaxConcurrentSlots(repository)}`);
  if (repository.incremental !== trusted.incremental) reasons.push(`changes incremental from ${trusted.incremental} to ${repository.incremental}`);
  if (repository.requirementsSlot !== trusted.requirementsSlot) reasons.push(`changes requirementsSlot from ${String(trusted.requirementsSlot)} to ${String(repository.requirementsSlot)}`);
  const repositoryIds = new Set(repository.slots.map(slot => slot.id));
  trusted.slots.forEach((slot, index) => {
    const candidate = repository.slots[index];
    if (!repositoryIds.has(slot.id)) return void reasons.push(`removes slot ${slot.id}`);
    if (candidate?.id !== slot.id) return void reasons.push(`moves slot ${slot.id} from position ${index}`);
    if (candidate.stage !== slot.stage) reasons.push(`changes slot ${slot.id} stage`);
    if (stableStringify(candidate.harness) !== stableStringify(slot.harness)) reasons.push(`changes slot ${slot.id} harness`);
    if (stableStringify(candidate.inference) !== stableStringify(slot.inference)) reasons.push(`changes slot ${slot.id} inference (provider, model, auth or credential)`);
    if (candidate.lens !== slot.lens) reasons.push(`changes slot ${slot.id} lens`);
    for (const key of ["timeoutMs", "maxOutputBytes"] as const) if (candidate.budget[key] > slot.budget[key]) reasons.push(`raises slot ${slot.id} budget.${key}`);
  });
  const lensesByPair = new Map<string, Set<string>>();
  for (const slot of trusted.slots) lensesByPair.set(pairKey(slot), (lensesByPair.get(pairKey(slot)) ?? new Set()).add(slot.lens));
  for (const added of repository.slots.slice(trusted.slots.length)) {
    if (trusted.slots.some(slot => slot.id === added.id)) continue;
    const pairs = trusted.slots.filter(slot => pairKey(slot) === pairKey(added));
    if (!pairs.length) { reasons.push(`adds slot ${added.id}, whose stage, harness and model pair the trusted policy does not have`); continue; }
    // An added slot brings a new lens to its pair: repeating a lens would only add a collapsed duplicate run.
    const lenses = lensesByPair.get(pairKey(added))!;
    if (lenses.has(added.lens)) reasons.push(`adds slot ${added.id} with lens ${added.lens}, which its stage, harness and model pair already has`);
    lenses.add(added.lens);
    for (const key of ["timeoutMs", "maxOutputBytes"] as const) if (added.budget[key] > Math.max(...pairs.map(slot => slot.budget[key]))) reasons.push(`adds slot ${added.id} with a larger budget.${key} than its trusted pair`);
  }
  if (reasons.length) throw new ReviewFnError("REVIEWFN_PANEL_POLICY_WEAKENED", `The repository panel policy weakens the trusted policy: it ${reasons.join("; ")}.`, { reasons });
  return repository;
}

function repositoryRelative(relative: string): string {
  if (!relative || path.isAbsolute(relative) || relative.startsWith("/") || relative.split(/[\\/]/).some(part => part === ".." || part === "")) throw new ReviewFnError("REVIEWFN_CONFIG_INVALID", "The panel policy path must be repository-relative.");
  return relative.split("\\").join("/");
}

function parseJson(text: string, origin: string): unknown {
  try { return JSON.parse(text); }
  catch (error) { throw new ReviewFnError("REVIEWFN_CONFIG_INVALID", `The panel policy at ${origin} is not JSON: ${error instanceof Error ? error.message : String(error)}`); }
}

async function git(root: string, args: string[], signal?: AbortSignal): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-c", `core.hooksPath=${devNull}`, ...args], { cwd: root, env: isolatedGitEnvironment(), maxBuffer: MAX_POLICY_BYTES * 2, signal, encoding: "utf8" });
  return stdout;
}

/**
 * The panel policy JSON committed at `revision`, read from the object store without the working tree, filters or
 * text conversion. `undefined` when the revision has no file at that path.
 */
export async function readPanelPolicyAtRevision(root: string, revision: string, relative = PANEL_POLICY_PATH, signal?: AbortSignal): Promise<unknown | undefined> {
  const file = repositoryRelative(relative);
  const commit = (await git(root, ["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`], signal)).trim();
  const entry = await git(root, ["ls-tree", "-z", "--full-tree", commit, "--", file], signal);
  if (!entry) return undefined;
  const match = /^(\d{6}) (\w+) ([0-9a-f]{40,64})\t/.exec(entry);
  if (!match || match[2] !== "blob" || !["100644", "100755"].includes(match[1])) throw new ReviewFnError("REVIEWFN_CONFIG_INVALID", `The panel policy ${file} at ${commit} is not a regular file.`);
  const size = Number((await git(root, ["cat-file", "-s", match[3]], signal)).trim());
  if (!Number.isSafeInteger(size) || size > MAX_POLICY_BYTES) throw new ReviewFnError("REVIEWFN_CONFIG_INVALID", `The panel policy ${file} at ${commit} exceeds ${MAX_POLICY_BYTES} bytes.`);
  return parseJson(await git(root, ["cat-file", "blob", match[3]], signal), `${commit}:${file}`);
}

export interface PanelPolicyLoadOptions {
  root: string;
  base: string;
  head: string;
  /** In CI, or with `--trusted-config-from-base`: the base revision's copy is trusted and the head copy may only tighten it. */
  trustedFromBase: boolean;
  path?: string;
  signal?: AbortSignal;
}

export interface LoadedPanelPolicy {
  policy: PanelPolicy;
  /** `base`: the trusted copy alone; `base+repository`: the head copy tightened it; `working-tree`: a local, untrusted run. */
  source: "base" | "base+repository" | "working-tree";
}

/**
 * Load the panel policy. With `trustedFromBase` the base revision's copy is required, and a head copy that differs is
 * applied with `applyRepositoryPanelPolicy`, so a pull request cannot weaken the panel reviewing it. Otherwise the
 * working tree copy is used, as a local 0.1 run uses its working tree policy.
 */
export async function loadPanelPolicy(options: PanelPolicyLoadOptions): Promise<LoadedPanelPolicy> {
  const relative = repositoryRelative(options.path ?? PANEL_POLICY_PATH);
  if (!options.trustedFromBase) {
    const bytes = await safeRead(path.resolve(options.root, relative), MAX_POLICY_BYTES);
    return { policy: parsePanelPolicy(parseJson(bytes.toString("utf8"), relative)), source: "working-tree" };
  }
  const trustedInput = await readPanelPolicyAtRevision(options.root, options.base, relative, options.signal);
  if (trustedInput === undefined) throw new ReviewFnError("REVIEWFN_CONFIG_INVALID", `The trusted base revision has no panel policy at ${relative}.`);
  const trusted = parsePanelPolicy(trustedInput);
  const repository = await readPanelPolicyAtRevision(options.root, options.head, relative, options.signal);
  if (repository === undefined || stableStringify(repository) === stableStringify(trusted)) return { policy: trusted, source: "base" };
  return { policy: applyRepositoryPanelPolicy(trusted, repository), source: "base+repository" };
}
