import { ENDPOINT_INTERFACE, LIVE_MATRIX_TARGET, NETWORKING_MATRIX, NETWORKING_QUALIFICATION_CONTRACT, QUALIFIED_PLATFORMS, type QualificationScenario } from "./matrix.js";
import type { InventoryEntry } from "./inventory.js";
import type { PrerequisiteResult, ScenarioResult, ScenarioStatus } from "./runner.js";

export const RECEIPT_CHECK = "networking-qualification-contract";

/** The code a run qualified: one clean checkout at head whose DevFn CLI and harness were built after its sources. */
export interface Provenance { head: string; checkout: string; clean: boolean; builtAfterSources: boolean; devfnCli: string }

/** One host's live run. Only a valid receipt whose scenarios passed is acceptance evidence. */
export interface NetworkingQualificationReceipt {
  contract: typeof NETWORKING_QUALIFICATION_CONTRACT;
  check: typeof RECEIPT_CHECK;
  target: typeof LIVE_MATRIX_TARGET;
  head: string;
  runId: string;
  provenance: Provenance;
  host: { platform: string; arch: string; release: string; node: string };
  startedAt: string;
  finishedAt: string;
  approval?: { approvedBy: string; expiresAt: string };
  prerequisites: PrerequisiteResult[];
  scenarios: ScenarioResult[];
  /** Resources the whole run shares, such as its DevFn Caddy and the processes of its root, with their cleanup read-back. */
  runResources: InventoryEntry[];
  interface: typeof ENDPOINT_INTERFACE;
  /** Host and provider limitations observed or reported during the run. */
  limitations: string[];
  summary: Record<ScenarioStatus, number>;
}

export function summarize(scenarios: readonly ScenarioResult[]): Record<ScenarioStatus, number> {
  const summary: Record<ScenarioStatus, number> = { passed: 0, failed: 0, blocked: 0, unsupported: 0 };
  for (const scenario of scenarios) summary[scenario.status] += 1;
  return summary;
}

/** Replace every occurrence of each secret value in every string of value. */
export function redactSecrets<T>(value: T, secrets: readonly string[]): T {
  const values = [...new Set(secrets.filter((secret) => secret.length >= 4))].sort((a, b) => b.length - a.length);
  const walk = (item: unknown): unknown => {
    if (typeof item === "string") return values.reduce((text, secret) => text.split(secret).join("[redacted]"), item);
    if (Array.isArray(item)) return item.map(walk);
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, walk(entry)]));
    return item;
  };
  return walk(value) as T;
}

/**
 * Problems that make a receipt unusable as evidence. A passed scenario must
 * come from a qualified platform and carry a passing observation of every
 * planned assertion, no failed one, resources read back absent and no
 * protected change. The receipt must come from a clean, freshly built
 * checkout at its head, every run-level resource must be read back absent,
 * and the summary must match the scenarios.
 */
export function receiptProblems(receipt: NetworkingQualificationReceipt, matrix: readonly QualificationScenario[] = NETWORKING_MATRIX): string[] {
  const problems: string[] = [];
  if (receipt.contract !== NETWORKING_QUALIFICATION_CONTRACT || receipt.check !== RECEIPT_CHECK) problems.push("not a networking qualification receipt");
  if (!/^[a-f0-9]{40}$/.test(receipt.head)) problems.push("head is not a full commit SHA");
  const source = receipt.provenance;
  if (source?.head !== receipt.head || source.clean !== true || source.builtAfterSources !== true) problems.push("not run from a clean checkout built at its head");
  for (const entry of receipt.runResources ?? []) if (entry.cleanup?.absent !== true) problems.push(`run-level ${entry.kind} ${entry.id} not read back absent`);
  if (!receipt.runResources?.some((entry) => entry.kind === "proxy") || !receipt.runResources.some((entry) => entry.kind === "run-processes")) problems.push("run-level cleanup was not recorded");
  const seen = new Set<string>();
  for (const scenario of receipt.scenarios) {
    const definition = matrix.find((item) => item.id === scenario.id);
    if (!definition) { problems.push(`${scenario.id}: not in the matrix`); continue; }
    if (seen.has(scenario.id)) problems.push(`${scenario.id}: reported twice`);
    seen.add(scenario.id);
    if (scenario.status !== "passed") continue;
    if (!(QUALIFIED_PLATFORMS as readonly string[]).includes(receipt.host.platform)) problems.push(`${scenario.id}: passed on unqualified platform ${receipt.host.platform}`);
    for (const assertion of definition.assertions) {
      const observed = scenario.observations.filter((item) => item.assertion === assertion.id);
      if (!observed.length) problems.push(`${scenario.id}: passed without observing ${assertion.id}`);
      if (observed.some((item) => !item.ok)) problems.push(`${scenario.id}: passed with failed ${assertion.id}`);
    }
    if (scenario.resources.some((entry) => entry.cleanup?.absent !== true)) problems.push(`${scenario.id}: passed with a resource not read back absent`);
    if (scenario.protectedChanges.length) problems.push(`${scenario.id}: passed with protected inventory changes`);
  }
  const summary = summarize(receipt.scenarios);
  if ((Object.keys(summary) as ScenarioStatus[]).some((key) => summary[key] !== receipt.summary[key])) problems.push("summary does not match scenarios");
  return problems;
}

export interface OutcomeGate { ready: boolean; missing: string[] }

/**
 * The DEV-2 networking outcome gate: every matrix scenario passed in a valid
 * live receipt for the exact head on each qualified platform. Anything less
 * keeps the outcome open; a Windows receipt never satisfies it.
 */
export function networkingOutcomeGate(receipts: readonly NetworkingQualificationReceipt[], head: string, matrix: readonly QualificationScenario[] = NETWORKING_MATRIX): OutcomeGate {
  const missing: string[] = [];
  for (const platform of QUALIFIED_PLATFORMS) {
    const valid = receipts.filter((receipt) => receipt.head === head && receipt.host.platform === platform && receiptProblems(receipt, matrix).length === 0);
    for (const scenario of matrix) {
      if (!valid.some((receipt) => receipt.scenarios.some((item) => item.id === scenario.id && item.status === "passed"))) missing.push(`${platform}: ${scenario.id}`);
    }
  }
  return { ready: missing.length === 0, missing };
}
