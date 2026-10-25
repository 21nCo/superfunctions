import path from "node:path";

import type { ResourceKind } from "./matrix.js";

/**
 * A disposable resource this run created. Only recorded resources are ever
 * removed, and a removal counts only once a read-back finds it absent.
 */
export interface InventoryEntry {
  kind: ResourceKind;
  /** Hostname, binding or domain name, or an absolute path for local resources. */
  id: string;
  scenario: string;
  createdAt: string;
  cleanup?: { absent: boolean; detail: string; checkedAt: string };
}

export interface ResourceHandlers {
  /** Remove one resource; an already absent resource is success. */
  remove(entry: InventoryEntry): Promise<void>;
  /** Read back whether the resource still exists. A failed read must throw, never report absence. */
  present(entry: InventoryEntry): Promise<boolean>;
}

export class InventoryError extends Error {
  public constructor(message: string) { super(message); this.name = "InventoryError"; }
}

/**
 * The run's disposable resource ledger. A resource outside the approved
 * nonproduction scope (the run root for local resources, an approved domain
 * for names, the run's own prefix for bindings) is refused before it exists.
 */
export class DisposableInventory {
  private readonly entries: InventoryEntry[] = [];

  public constructor(private readonly scope: { runId: string; root: string; domains: readonly string[] }, private readonly now: () => Date = () => new Date()) {
    if (!/^[a-z0-9]{8,16}$/.test(scope.runId)) throw new InventoryError("A run ID is 8 to 16 lowercase letters or digits.");
    if (!path.isAbsolute(scope.root)) throw new InventoryError("The run root must be an absolute path.");
  }

  /** Name prefix for bindings and labels this run creates. */
  public get prefix(): string { return `q${this.scope.runId.slice(0, 8)}`; }

  public record(kind: ResourceKind, id: string, scenario: string): InventoryEntry {
    const relative = path.relative(this.scope.root, id);
    if ((kind === "fixture-repository" || kind === "runtime" || kind === "proxy") && (!path.isAbsolute(id) || !relative || relative.startsWith("..") || path.isAbsolute(relative))) {
      throw new InventoryError(`${kind} ${id} is outside the run root.`);
    }
    if ((kind === "registered-domain" || kind === "oauth-relay") && !this.scope.domains.includes(id)) throw new InventoryError(`${kind} ${id} is not an approved domain.`);
    // Public names carry the run prefix in their worktree label, under an approved domain or the run's own ephemeral origin namespace.
    const [label = "", parent = ""] = id.split(".");
    const namespace = this.scope.domains.some((domain) => id.endsWith(`.${domain}`)) || (id.endsWith(".ngrok.devfn.internal") && parent.startsWith(`${this.prefix}-`));
    if (kind === "public-hostname" && !(label.includes(this.prefix) && namespace)) throw new InventoryError(`public hostname ${id} is not a run-owned name under an approved domain.`);
    if (kind === "tunnel-binding" && !id.startsWith(`${this.prefix}-`)) throw new InventoryError(`tunnel binding ${id} is not named for this run.`);
    if (this.entries.some((entry) => entry.kind === kind && entry.id === id && !entry.cleanup?.absent)) throw new InventoryError(`${kind} ${id} is already recorded.`);
    const entry: InventoryEntry = { kind, id, scenario, createdAt: this.now().toISOString() };
    this.entries.push(entry);
    return entry;
  }

  /**
   * Remove every recorded resource not yet confirmed absent, newest first,
   * then read each back. A removal error does not skip the read-back, and a
   * read-back error leaves the resource unconfirmed.
   */
  public async cleanup(handlers: ResourceHandlers, scenario?: string): Promise<InventoryEntry[]> {
    const pending = this.entries.filter((entry) => !entry.cleanup?.absent && (scenario === undefined || entry.scenario === scenario)).reverse();
    for (const entry of pending) {
      let removal = "";
      try { await handlers.remove(entry); } catch (error) { removal = `removal failed: ${message(error)}; `; }
      let cleanup: InventoryEntry["cleanup"];
      try {
        const present = await handlers.present(entry);
        cleanup = { absent: !present, detail: `${removal}${present ? "still present on read-back" : "absent on read-back"}`, checkedAt: this.now().toISOString() };
      } catch (error) {
        cleanup = { absent: false, detail: `${removal}read-back failed: ${message(error)}`, checkedAt: this.now().toISOString() };
      }
      entry.cleanup = cleanup;
    }
    return pending;
  }

  public list(scenario?: string): InventoryEntry[] {
    return this.entries.filter((entry) => scenario === undefined || entry.scenario === scenario).map((entry) => ({ ...entry, ...(entry.cleanup ? { cleanup: { ...entry.cleanup } } : {}) }));
  }

  public allAbsent(scenario?: string): boolean { return this.list(scenario).every((entry) => entry.cleanup?.absent === true); }
}

/**
 * Resources the run must not change: the operator's runtimes, routes,
 * registered domains and tunnel bindings outside the run. Values are compared
 * as sorted identifiers so only additions, removals and changes are reported.
 */
export type ProtectedSnapshot = Readonly<Record<string, readonly string[]>>;

export function protectedChanges(before: ProtectedSnapshot, after: ProtectedSnapshot): string[] {
  const changes: string[] = [];
  for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    const was = new Set(before[key] ?? []);
    const now = new Set(after[key] ?? []);
    if (!(key in before) || !(key in after)) { changes.push(`${key}: ${key in before ? "no longer readable" : "newly readable"}`); continue; }
    for (const item of [...was].filter((value) => !now.has(value)).sort()) changes.push(`${key}: removed ${item}`);
    for (const item of [...now].filter((value) => !was.has(value)).sort()) changes.push(`${key}: added ${item}`);
  }
  return changes;
}

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
