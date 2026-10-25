import { DisposableInventory, protectedChanges, type InventoryEntry, type ProtectedSnapshot, type ResourceHandlers } from "./inventory.js";
import { LIVE_MATRIX_TARGET, NETWORKING_MATRIX, QUALIFIED_PLATFORMS, type PrerequisiteId, type QualificationScenario } from "./matrix.js";

export type PrerequisiteStatus = "satisfied" | "missing" | "invalid";
export interface PrerequisiteResult { id: PrerequisiteId; status: PrerequisiteStatus; detail: string }

/**
 * passed: a live run observed every planned assertion and confirmed cleanup;
 * blocked: a prerequisite or driver is unavailable, so nothing was proven;
 * unsupported: the host is not a qualified platform. Only passed is a pass.
 */
export type ScenarioStatus = "passed" | "failed" | "blocked" | "unsupported";

export interface Observation { assertion: string; ok: boolean; detail: string; observedAt: string }

export interface ScenarioResult {
  id: string;
  row: QualificationScenario["row"];
  status: ScenarioStatus;
  reason?: string;
  observations: Observation[];
  resources: InventoryEntry[];
  protectedChanges: string[];
}

export class ObservationError extends Error {
  public constructor(message: string) { super(message); this.name = "ObservationError"; }
}

export interface ScenarioContext {
  scenario: QualificationScenario;
  inventory: DisposableInventory;
  /** Record one planned assertion's outcome. An unplanned assertion ID throws. */
  observe(assertion: string, ok: boolean, detail: string): void;
  /** Throw unless condition holds, recording the observation either way. */
  expect(assertion: string, condition: boolean, detail: string): void;
}

export type ScenarioDriver = (context: ScenarioContext) => Promise<void>;

export interface Selection { scenarios?: readonly string[]; rows?: readonly number[] }

/** The selected scenarios in matrix order. Unknown IDs or rows and an empty selection fail closed. */
export function selectScenarios(selection: Selection = {}, matrix: readonly QualificationScenario[] = NETWORKING_MATRIX): QualificationScenario[] {
  const known = new Set(matrix.map((scenario) => scenario.id));
  const unknown = (selection.scenarios ?? []).filter((id) => !known.has(id));
  if (unknown.length) throw new RangeError(`Unknown qualification scenarios: ${unknown.join(", ")}.`);
  const badRows = (selection.rows ?? []).filter((row) => !matrix.some((scenario) => scenario.row === row));
  if (badRows.length) throw new RangeError(`Unknown matrix rows: ${badRows.join(", ")}.`);
  const selected = matrix.filter((scenario) => (!selection.scenarios?.length || selection.scenarios.includes(scenario.id)) && (!selection.rows?.length || selection.rows.includes(scenario.row)));
  if (!selected.length) throw new RangeError("The selection names no qualification scenario.");
  return selected;
}

export interface RunOptions {
  scenarios: readonly QualificationScenario[];
  platform: NodeJS.Platform;
  prerequisites: readonly PrerequisiteResult[];
  drivers: Readonly<Record<string, ScenarioDriver>>;
  inventory: DisposableInventory;
  resources: ResourceHandlers;
  /** Read the protected inventory; a failed read throws. */
  snapshot: () => Promise<ProtectedSnapshot>;
  now?: () => Date;
}

/** Why a scenario cannot run here, before anything is created. */
function blockedReason(scenario: QualificationScenario, options: RunOptions): Pick<ScenarioResult, "status" | "reason"> | undefined {
  if (!(QUALIFIED_PLATFORMS as readonly string[]).includes(options.platform)) return { status: "unsupported", reason: `${options.platform} is not a qualified DevFn host; no support is claimed without its own evidence.` };
  const results = new Map(options.prerequisites.map((item) => [item.id, item]));
  const unmet = scenario.prerequisites.filter((id) => results.get(id)?.status !== "satisfied");
  if (unmet.length) return { status: "blocked", reason: `EXTERNAL_ACCEPTANCE_GATE: ${LIVE_MATRIX_TARGET} needs ${unmet.map((id) => `${id} (${results.get(id)?.detail ?? "not checked"})`).join("; ")}` };
  if (!options.drivers[scenario.id]) return { status: "blocked", reason: `No live driver is registered for ${scenario.id}.` };
  return undefined;
}

/**
 * Run each selected scenario in order. A scenario passes only when its
 * driver returns, every planned assertion was observed and none failed,
 * each resource it created is read back absent and the protected inventory
 * is unchanged. Cleanup and the protected read run even when a driver throws.
 */
export async function runScenarios(options: RunOptions): Promise<ScenarioResult[]> {
  const now = options.now ?? (() => new Date());
  const results: ScenarioResult[] = [];
  for (const scenario of options.scenarios) {
    const blocked = blockedReason(scenario, options);
    if (blocked) { results.push({ id: scenario.id, row: scenario.row, ...blocked, observations: [], resources: [], protectedChanges: [] }); continue; }
    const planned = new Set(scenario.assertions.map((item) => item.id));
    const observations: Observation[] = [];
    const observe = (assertion: string, ok: boolean, detail: string): void => {
      if (!planned.has(assertion)) throw new ObservationError(`${scenario.id} has no planned assertion ${assertion}.`);
      observations.push({ assertion, ok, detail, observedAt: now().toISOString() });
    };
    const context: ScenarioContext = { scenario, inventory: options.inventory, observe,
      expect: (assertion, condition, detail) => { observe(assertion, condition, detail); if (!condition) throw new ObservationError(`${scenario.id} ${assertion}: ${detail}`); } };
    let failure: string | undefined;
    let changes: string[] = [];
    let before: ProtectedSnapshot | undefined;
    try { before = await options.snapshot(); } catch (error) { failure = `protected inventory unreadable before start: ${message(error)}`; }
    if (before) {
      try { await options.drivers[scenario.id](context); } catch (error) { failure = `driver: ${message(error)}`; }
    }
    await options.inventory.cleanup(options.resources, scenario.id);
    if (before) changes = await options.snapshot().then((after) => protectedChanges(before!, after), (error: unknown) => [`protected inventory unreadable: ${message(error)}`]);
    const missing = [...planned].filter((id) => !observations.some((item) => item.assertion === id));
    const failed = [...new Set(observations.filter((item) => !item.ok).map((item) => item.assertion))];
    const leaked = options.inventory.list(scenario.id).filter((entry) => !entry.cleanup?.absent).map((entry) => `${entry.kind} ${entry.id}`);
    const reasons = [
      ...(failure ? [failure] : []), ...(failed.length ? [`failed: ${failed.join(", ")}`] : []), ...(missing.length ? [`not observed: ${missing.join(", ")}`] : []),
      ...(leaked.length ? [`not confirmed absent: ${leaked.join(", ")}`] : []), ...(changes.length ? [`protected inventory changed: ${changes.join("; ")}`] : []),
    ];
    results.push({ id: scenario.id, row: scenario.row, status: reasons.length ? "failed" : "passed", ...(reasons.length ? { reason: reasons.join(" | ") } : {}),
      observations, resources: options.inventory.list(scenario.id), protectedChanges: changes });
  }
  return results;
}

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
