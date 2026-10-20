import { createRouteContext, PayloadTooLargeError } from "@superfunctions/http";
import { bugReportSchema } from "../core/bug-report";
import { BugIssueConflictError, BugIssueValidationError } from "../integrations/botfn/types";
import { WatchFn } from "../core/watch-fn";
import { QueryValidationError } from "../query/query-engine";


export class HttpHandlers {
  private watch: WatchFn;

  constructor(watch: WatchFn) {
    this.watch = watch;
  }

  async health() {
    return new Response(JSON.stringify({ status: "ok", version: "0.1.0" }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  async ingest(request: Request) {
    const reply = (body: unknown, status: number) => new Response(JSON.stringify(body), {
      status, headers: { "Content-Type": "application/json" },
    });
    if (!this.watch.authorizeIngest(request)) return reply({ error: "Unauthorized" }, 401);
    let body: unknown;
    try {
      body = await createRouteContext(request, {}, { maxBodyBytes: 8 * 1024 * 1024 }).json();
    } catch (error) {
      const tooLarge = error instanceof PayloadTooLargeError;
      return reply({ error: tooLarge ? "Request body too large" : "Invalid JSON" }, tooLarge ? 413 : 400);
    }
    const events: unknown = Array.isArray(body) ? body
      : body && typeof body === "object" && "events" in body ? body.events : [body];
    if (!Array.isArray(events) || events.length === 0 || events.length > 500) return reply({ error: "Invalid batch" }, 400);
    const encoder = new TextEncoder();
    for (const event of events) {
      if (!event || typeof event !== "object" || Array.isArray(event)) return reply({ error: "Invalid event" }, 400);
      const value = event as Record<string, unknown>;
      if (value.type === "bug_report") {
        if (!bugReportSchema.safeParse(value).success) return reply({ error: "Invalid bug report" }, 400);
      } else if (typeof value.name !== "string" || !value.name.trim()) {
        return reply({ error: "Event name is required" }, 400);
      }
      if (encoder.encode(JSON.stringify(value)).byteLength > 64 * 1024) return reply({ error: "Event too large" }, 413);
    }
    try {
      await this.watch.ingest(events as Record<string, unknown>[]);
    } catch (error) {
      if (error instanceof BugIssueConflictError) return reply({ error: "Bug report ID conflicts with existing content" }, 409);
      if (error instanceof BugIssueValidationError) return reply({ error: "Invalid bug integration request" }, 400);
      return reply({ error: "Storage unavailable" }, 503);
    }
    return reply({ accepted: events.length }, 202);
  }

  async issueStatus(request: Request) {
    const reply = (body: unknown, status: number) => new Response(JSON.stringify(body), {
      status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
    if (!this.watch.authorizeIngest(request)) return reply({ error: "Unauthorized" }, 401);
    let body: any;
    try { body = await createRouteContext(request, {}, { maxBodyBytes: 4096 }).json(); }
    catch (error) { return reply({ error: "Invalid status request" }, error instanceof PayloadTooLargeError ? 413 : 400); }
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => !["app", "reportId"].includes(key)) ||
        typeof body.app !== "string" || !body.app.trim() || body.app.length > 200 ||
        typeof body.reportId !== "string" || !body.reportId.trim() || body.reportId.length > 256) return reply({ error: "Invalid status request" }, 400);
    try {
      const status = await this.watch.getBugIssueStatus(body);
      if (!status) return reply({ error: "Report not found" }, 404);
      const { app, reportId, target, state, issueId, issueUrl } = status;
      if (app !== body.app || reportId !== body.reportId || !["github", "linear"].includes(target) || !["pending", "processing", "reconciliation", "linked"].includes(state)) throw new Error("Invalid issue status");
      if (state !== "linked" && (issueId !== null || issueUrl !== null)) throw new Error("Unverified issue link");
      if (state === "linked") {
        const url = new URL(issueUrl!);
        if (!issueId || issueId.length > 128 || !issueUrl || issueUrl.length > 4096 || url.protocol !== "https:" || url.hostname !== (target === "github" ? "github.com" : "linear.app") || url.port || url.username || url.password || url.search || url.hash) throw new Error("Invalid issue link");
        if (target === "github" && url.pathname !== `/${status.project}/issues/${issueId}`) throw new Error("Invalid issue destination");
      }
      const result = { app, reportId, target, state, issueId, issueUrl };
      if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 16384) throw new Error("Status too large");
      return reply(result, 200);
    } catch { return reply({ error: "Issue status unavailable" }, 503); }
  }

  async query(request: Request) {
    const reply = (body: unknown, status: number) => new Response(JSON.stringify(body), {
      status, headers: { "Content-Type": "application/json" },
    });
    if (!this.watch.authorizeIngest(request)) return reply({ error: "Unauthorized" }, 401);
    let body: unknown;
    try {
      body = await createRouteContext(request, {}, { maxBodyBytes: 64 * 1024 }).json();
    } catch (error) {
      const tooLarge = error instanceof PayloadTooLargeError;
      return reply({ error: tooLarge ? "Request body too large" : "Invalid JSON" }, tooLarge ? 413 : 400);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return reply({ error: "Invalid query" }, 400);
    }
    try {
      // QueryEngine owns semantic validation for both programmatic and HTTP calls.
      const results = await this.watch.query(body);
      return reply({ results }, 200);
    } catch (error) {
      return error instanceof QueryValidationError
        ? reply({ error: "Invalid query" }, 400)
        : reply({ error: "Query unavailable" }, 503);
    }
  }
}
