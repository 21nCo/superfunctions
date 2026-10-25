import { closeSync, fsyncSync, openSync, renameSync, writeFileSync } from "node:fs";
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
  /** What removal and read-back need: the owning checkout, binding, URL and provider marker. */
  context?: { cwd?: string; binding?: string; url?: string; marker?: string };
  cleanup?: { absent: boolean; detail: string; checkedAt: string };
}

export interface ResourceHandlers {
  /** Remove one resource; an already absent resource is success. */
  remove(entry: InventoryEntry): Promise<void>;
  /** Read back whether the resource still exists; a string is present, saying what remains. A failed read must throw, never report absence. */
  present(entry: InventoryEntry): Promise<boolean | string>;
}

export class InventoryError extends Error {
  public constructor(message: string) { super(message); this.name = "InventoryError"; }
}

/**
 * The run's disposable resource ledger. A resource outside the approved
 * nonproduction scope (the run root for local resources, an approved domain
 * for names, the run's own prefix for bindings) is refused before it exists.
 * With a ledger file, every change is written there before the call returns,
 * so a resource is on disk before it is created and an interrupted run
 * leaves a readable list of what may remain.
 */
export class DisposableInventory {
  private readonly entries: InventoryEntry[] = [];

  public constructor(private readonly scope: { runId: string; root: string; domains: readonly string[]; ledger?: string }, private readonly now: () => Date = () => new Date()) {
    if (!/^[a-z0-9]{8,16}$/.test(scope.runId)) throw new InventoryError("A run ID is 8 to 16 lowercase letters or digits.");
    if (!path.isAbsolute(scope.root)) throw new InventoryError("The run root must be an absolute path.");
  }

  /** Name prefix for bindings and labels this run creates. */
  public get prefix(): string { return `q${this.scope.runId.slice(0, 8)}`; }

  public get ledger(): string | undefined { return this.scope.ledger; }

  public record(kind: ResourceKind, id: string, scenario: string, context?: InventoryEntry["context"]): InventoryEntry {
    if (kind === "run-processes" && id !== this.scope.root) throw new InventoryError(`run-processes ${id} is not the run root.`);
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
    const entry: InventoryEntry = { kind, id, scenario, createdAt: this.now().toISOString(), ...(context ? { context: { ...context } } : {}) };
    this.entries.push(entry);
    this.persist();
    return entry;
  }

  /** Add what read-back needs once it is known, such as the URL a provider assigned after the resource was recorded. */
  public attach(entry: InventoryEntry, context: NonNullable<InventoryEntry["context"]>): void {
    const recorded = this.entries.find((item) => item.kind === entry.kind && item.id === entry.id && item.scenario === entry.scenario && !item.cleanup?.absent);
    if (!recorded) throw new InventoryError(`${entry.kind} ${entry.id} is not recorded.`);
    recorded.context = { ...recorded.context, ...context };
    this.persist();
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
        cleanup = { absent: present === false, detail: `${removal}${present === false ? "absent on read-back" : `still present on read-back${typeof present === "string" ? `: ${present}` : ""}`}`, checkedAt: this.now().toISOString() };
      } catch (error) {
        cleanup = { absent: false, detail: `${removal}read-back failed: ${message(error)}`, checkedAt: this.now().toISOString() };
      }
      entry.cleanup = cleanup;
      this.persist();
    }
    return pending;
  }

  public list(scenario?: string): InventoryEntry[] {
    return this.entries.filter((entry) => scenario === undefined || entry.scenario === scenario)
      .map((entry) => ({ ...entry, ...(entry.context ? { context: { ...entry.context } } : {}), ...(entry.cleanup ? { cleanup: { ...entry.cleanup } } : {}) }));
  }

  public allAbsent(scenario?: string): boolean { return this.list(scenario).every((entry) => entry.cleanup?.absent === true); }

  /** Replace the ledger atomically: a synced 0600 sibling is renamed over it, so a crash leaves the previous or the new ledger, never a partial one. */
  private persist(): void {
    if (!this.scope.ledger) return;
    const temporary = `${this.scope.ledger}.${process.pid}.tmp`;
    const descriptor = openSync(temporary, "w", 0o600);
    try {
      writeFileSync(descriptor, `${JSON.stringify({ runId: this.scope.runId, root: this.scope.root, entries: this.entries }, null, 2)}\n`, "utf8");
      fsyncSync(descriptor);
    } finally { closeSync(descriptor); }
    renameSync(temporary, this.scope.ledger);
  }
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
