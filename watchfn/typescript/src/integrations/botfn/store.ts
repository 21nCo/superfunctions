import { createHash, randomUUID } from "node:crypto";
import { wrapWithSchema, type Adapter, type WhereClause } from "@superfunctions/db";
import { bugReportSchema } from "../../core/bug-report";
import { projectEvent } from "../../storage/projection";
import { getWatchFnSchema } from "../../storage/schema";
import { BUG_ISSUES_TABLE, getBugIssueSchema } from "./schema";
import { createBotFnIssue, verifyBotFnIssue } from "./provider";
import { BugIssueConflictError, BugIssueValidationError, type BotFnIssueConfig, type BotFnIssueRoute, type BugReportReference, type BugIssueStatus, type BugIssueLink } from "./types";

interface IssueRow extends BugIssueStatus {
  id: string; namespace: string; fingerprint: string; eventId: string; routeKey: string;
  revision: number; leaseToken: string | null; leaseExpiresAt: number; createdAt: number; updatedAt: number;
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const canonical = (value: any): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value);
const text = (value: unknown, max: number): value is string => typeof value === "string" && !!value.trim() && value.length <= max;
const snapshot = <T>(value: T): T => JSON.parse(JSON.stringify(value));

/** Durable canonical bug intake and delivery state. The host owns actual DB durability and migration. */
export class BotFnBugIssues {
  private readonly database: Adapter;
  private readonly namespace: string;
  private readonly routes = new Map<string, BotFnIssueRoute>();
  private readonly timeoutMs: number;
  private readonly leaseMs: number;
  private active?: Promise<{ processed: number }>;
  private cursor?: string;

  constructor(database: Adapter, config: BotFnIssueConfig, private readonly eventTable = "watchfn_events") {
    if (!database?.capabilities?.transactions?.supported || typeof database.transaction !== "function") throw new TypeError("BotFn bug ingestion requires a shared database adapter with transactions");
    if (!config || !text(config.namespace, 128) || !Array.isArray(config.routes) || !config.routes.length || config.routes.length > 100) throw new TypeError("Invalid BotFn issue configuration");
    this.namespace = config.namespace;
    this.timeoutMs = config.timeoutMs ?? 10000; this.leaseMs = config.leaseMs ?? 30000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 10 || this.timeoutMs > 60000 || !Number.isSafeInteger(this.leaseMs) || this.leaseMs < this.timeoutMs + 100 || this.leaseMs > 300000) throw new TypeError("Invalid BotFn issue timeout/lease");
    for (const route of config.routes) {
      if (!route || !text(route.app, 200) || !text(route.project, 200) || !route.client || typeof route.client.request !== "function" || !["github", "linear"].includes(route.target)) throw new TypeError("Invalid BotFn issue route");
      if (route.target === "github" ? !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(route.project) : !/^[A-Za-z0-9_-]{1,128}$/.test(route.project)) throw new TypeError("Invalid BotFn issue project");
      const key = this.routeKey(route); if (this.routes.has(key)) throw new TypeError("Duplicate BotFn issue route");
      // Copy only trusted routing fields; retain the client in memory, never in database state.
      this.routes.set(key, { app: route.app, target: route.target, project: route.project, client: route.client } as BotFnIssueRoute);
    }
    this.database = wrapWithSchema(database, { ...getWatchFnSchema(eventTable), ...getBugIssueSchema() });
  }
  private routeKey(route: Pick<BotFnIssueRoute, "app" | "target" | "project">) { return hash(JSON.stringify([this.namespace, route.app, route.target, route.project])); }
  private id(ref: BugReportReference) {
    if (!text(ref.app, 200) || !text(ref.reportId, 256)) throw new BugIssueValidationError("Invalid bug reference");
    return hash(JSON.stringify([this.namespace, ref.app, ref.reportId]));
  }
  private where(id: string): WhereClause[] { return [{ field: "namespace", operator: "eq", value: this.namespace }, { field: "id", operator: "eq", value: id }]; }
  private read(id: string, database: Pick<Adapter, "findOne"> = this.database) { return database.findOne<IssueRow>({ model: BUG_ISSUES_TABLE, where: this.where(id) }); }
  private routeFor(event: Record<string, any>): BotFnIssueRoute {
    const hint = event.integration;
    if (hint !== undefined && (!hint || typeof hint !== "object" || Array.isArray(hint) || Object.keys(hint).some(key => !["target", "project"].includes(key)) || (hint.target !== undefined && !["github", "linear"].includes(hint.target)) || (hint.project !== undefined && !text(hint.project, 200)))) throw new BugIssueValidationError("Invalid integration hint");
    const routes = [...this.routes.values()].filter(route => route.app === event.app.name && (hint?.target === undefined || hint.target === route.target) && (hint?.project === undefined || hint.project === route.project));
    if (routes.length !== 1) throw new BugIssueValidationError("No unique authorized issue route");
    return routes[0];
  }
  validate(event: Record<string, unknown>): void {
    if (!bugReportSchema.safeParse(event).success || !text((event.report as any)?.title, 255)) throw new BugIssueValidationError("Invalid canonical bug report");
    this.id({ app: (event.app as any).name, reportId: event.id as string }); this.routeFor(event);
  }
  async ingest(event: Record<string, unknown>): Promise<void> {
    const payload = snapshot(event); this.validate(payload);
    const ref = { app: (payload.app as any).name as string, reportId: payload.id as string };
    const id = this.id(ref); const fingerprint = hash(canonical(payload)); const route = this.routeFor(payload);
    const duplicate = (existing: IssueRow) => { if (existing.fingerprint !== fingerprint) throw new BugIssueConflictError("Bug report content conflicts"); };
    const existing = await this.read(id); if (existing) return duplicate(existing);
    const now = Date.now();
    try {
      await this.database.transaction(async tx => {
        await tx.create({ model: this.eventTable, data: { id: `bug_${id}`, payload, ...projectEvent(payload), receivedAt: now } });
        await tx.create({ model: BUG_ISSUES_TABLE, data: {
          id, namespace: this.namespace, ...ref, fingerprint, eventId: `bug_${id}`, routeKey: this.routeKey(route), target: route.target, project: route.project,
          state: "pending", revision: 0, attempts: 0, leaseToken: null, leaseExpiresAt: 0, createdAt: now, updatedAt: now,
          issueId: null, issueUrl: null, failure: null,
        } });
      });
    } catch (error) {
      const winner = await this.read(id); if (winner) return duplicate(winner);
      throw error;
    }
  }
  async status(ref: BugReportReference): Promise<BugIssueStatus | null> {
    const row = await this.read(this.id(ref)); if (!row) return null;
    const { app, reportId, state, attempts, target, project, issueId, issueUrl, failure } = row;
    return { app, reportId, state, attempts, target, project, issueId, issueUrl, failure };
  }
  private async cas(row: IssueRow, data: Record<string, unknown>, database: Pick<Adapter, "updateMany"> = this.database): Promise<boolean> {
    const count = await database.updateMany({ model: BUG_ISSUES_TABLE, where: [...this.where(row.id), { field: "revision", operator: "eq", value: row.revision }], data: { ...data, revision: row.revision + 1, updatedAt: Date.now() } });
    if (count > 1) throw new Error("Issue state update affected multiple records"); return count === 1;
  }
  private async claim(id: string): Promise<IssueRow | null> {
    const row = await this.read(id); if (!row) return null;
    if (row.state === "processing") {
      if (row.leaseExpiresAt <= Date.now()) await this.cas(row, { state: "reconciliation", failure: "lease_expired", leaseToken: null, leaseExpiresAt: 0 });
      return null;
    }
    if (row.state !== "pending") return null;
    const next = { state: "processing" as const, attempts: row.attempts + 1, leaseToken: randomUUID(), leaseExpiresAt: Date.now() + this.leaseMs };
    return await this.cas(row, next) ? { ...row, ...next, revision: row.revision + 1 } : null;
  }
  private async park(claim: IssueRow, failure: string): Promise<void> {
    const current = await this.read(claim.id);
    if (current?.state === "processing" && current.leaseToken === claim.leaseToken) await this.cas(current, { state: "reconciliation", failure, leaseToken: null, leaseExpiresAt: 0 });
  }
  private async link(row: IssueRow, result: BugIssueLink, expectedState: "processing" | "reconciliation"): Promise<boolean> {
    return this.database.transaction(async tx => {
      const current = await this.read(row.id, tx);
      if (!current || current.state !== expectedState || current.revision !== row.revision || (expectedState === "processing" && (current.leaseToken !== row.leaseToken || current.leaseExpiresAt <= Date.now()))) return false;
      if (!await this.cas(current, { state: "linked", issueId: result.issueId, issueUrl: result.issueUrl, failure: null, leaseToken: null, leaseExpiresAt: 0 }, tx)) return false;
      const event = await tx.findOne<{ payload: Record<string, unknown> }>({ model: this.eventTable, where: [{ field: "id", operator: "eq", value: current.eventId }] });
      if (!event) throw new Error("Canonical bug event is unavailable");
      const payload = { ...event.payload, integration: { target: current.target, project: current.project, ...result } };
      const updated = await tx.updateMany({ model: this.eventTable, where: [{ field: "id", operator: "eq", value: current.eventId }], data: { payload, ...projectEvent(payload) } });
      if (updated !== 1) throw new Error("Canonical bug event update failed");
      return true;
    });
  }
  private async timed<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([Promise.resolve().then(() => operation(controller.signal)), new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("Provider outcome unknown")); }, this.timeoutMs); })]); }
    finally { if (timer) clearTimeout(timer); }
  }
  /** One bounded page. Multiple workers use DB CAS claims; no automatic uncertain-create replay. */
  process(limit = 20): Promise<{ processed: number }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return Promise.reject(new TypeError("Issue processing limit must be 1–100"));
    if (this.active) return this.active;
    this.active = (async () => {
      const rows = await this.database.findMany<IssueRow>({ model: BUG_ISSUES_TABLE, where: [
        { field: "namespace", operator: "eq", value: this.namespace }, { field: "state", operator: "in", value: ["pending", "processing"] },
        ...(this.cursor ? [{ field: "id", operator: "gt" as const, value: this.cursor }] : []),
      ], orderBy: [{ field: "id", direction: "asc" }], limit });
      this.cursor = rows.length === limit ? rows[rows.length - 1].id : undefined;
      let processed = 0;
      for (const candidate of rows) {
        const claim = await this.claim(candidate.id); if (!claim) continue; processed++;
        const route = this.routes.get(claim.routeKey);
        if (!route) { await this.park(claim, "route_unavailable"); continue; }
        const event = await this.database.findOne<{ payload: Record<string, unknown> }>({ model: this.eventTable, where: [{ field: "id", operator: "eq", value: claim.eventId }] });
        if (!event) { await this.park(claim, "event_unavailable"); continue; }
        try {
          const result = await this.timed(signal => createBotFnIssue(route, event.payload, claim.id, signal));
          if (!await this.link(claim, result, "processing")) await this.park(claim, "lease_expired");
        } catch { await this.park(claim, "provider_outcome_unknown"); }
      }
      return { processed };
    })().finally(() => { this.active = undefined; });
    return this.active;
  }
  /** Privileged server method: verifies provider state, never accepts an arbitrary operator URL. */
  async reconcile(ref: BugReportReference, issueId: string): Promise<boolean> {
    const row = await this.read(this.id(ref));
    if (!row || row.state !== "reconciliation") return false;
    const route = this.routes.get(row.routeKey); if (!route) throw new Error("Issue route unavailable");
    const result = await this.timed(signal => verifyBotFnIssue(route, issueId, row.id, signal));
    return this.link(row, result, "reconciliation");
  }
}
