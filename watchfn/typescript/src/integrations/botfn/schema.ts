import type { TableSchema } from "@superfunctions/db";
export const BUG_ISSUES_TABLE = "watchfn_bug_issues";
export function getBugIssueSchema(): Record<string, TableSchema> {
  return { [BUG_ISSUES_TABLE]: { modelName: BUG_ISSUES_TABLE, fields: {
    id: { type: "string", required: true, unique: true },
    namespace: { type: "string", required: true }, app: { type: "string", required: true }, reportId: { type: "string", required: true },
    fingerprint: { type: "string", required: true }, eventId: { type: "string", required: true }, routeKey: { type: "string", required: true },
    target: { type: "string", required: true }, project: { type: "string", required: true },
    state: { type: "string", required: true }, revision: { type: "number", required: true }, attempts: { type: "number", required: true },
    leaseToken: { type: "string" }, leaseExpiresAt: { type: "number", required: true },
    createdAt: { type: "number", required: true }, updatedAt: { type: "number", required: true },
    issueId: { type: "string" }, issueUrl: { type: "string" }, failure: { type: "string" },
  }, indexes: [{ name: "watchfn_bug_issues_queue", fields: ["namespace", "state", "id"] }] } };
}
