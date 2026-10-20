/** Structural contracts implemented by BotFn's existing authenticated clients. */
export interface BotFnGitHubClient { request<T = any>(endpoint: string, options?: RequestInit): Promise<T>; }
export interface BotFnLinearClient { request<T>(query: string, variables?: Record<string, any>): Promise<T>; }
export type BotFnIssueRoute =
  | { app: string; target: "github"; project: string; client: BotFnGitHubClient }
  | { app: string; target: "linear"; project: string; client: BotFnLinearClient };
export interface BotFnIssueConfig {
  /** Server-owned outbox namespace; does not add tenant isolation to Watch queries. */
  namespace: string;
  /** Every holder of this Watch API key may select any route. Use one trusted application boundary. */
  routes: BotFnIssueRoute[];
  /** Bounds worker wait, not guaranteed cancellation of a supplied client. Default 10 seconds. */
  timeoutMs?: number;
  leaseMs?: number;
}
export interface BugReportReference { app: string; reportId: string; }
export interface BugIssueLink { issueId: string; issueUrl: string; }
export type BugIssueState = "pending" | "processing" | "reconciliation" | "linked";
export interface BugIssueStatus extends BugReportReference {
  state: BugIssueState; attempts: number; target: "github" | "linear"; project: string;
  issueId: string | null; issueUrl: string | null; failure: string | null;
}
export class BugIssueValidationError extends Error {}
export class BugIssueConflictError extends Error {}
