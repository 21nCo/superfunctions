export interface BugIssueReference { app: string; reportId: string; }
export interface BrowserBugIssueStatus extends BugIssueReference {
  target: "github" | "linear";
  state: "pending" | "processing" | "reconciliation" | "linked";
  issueId: string | null;
  issueUrl: string | null;
}

/** Validate network and injected-backend receipts before exposing a link to browser UI. */
export function parseBugIssueStatus(value: unknown, reference: BugIssueReference): BrowserBugIssueStatus {
  const row = value as BrowserBugIssueStatus;
  if (!row || typeof row !== "object" || Array.isArray(row) || row.app !== reference.app || row.reportId !== reference.reportId ||
      !["github", "linear"].includes(row.target) || !["pending", "processing", "reconciliation", "linked"].includes(row.state)) throw new Error("Invalid issue status response");
  if (row.state === "linked") {
    if (typeof row.issueId !== "string" || !row.issueId || row.issueId.length > 128 || typeof row.issueUrl !== "string" || row.issueUrl.length > 4096) throw new Error("Invalid issue link");
    const url = new URL(row.issueUrl);
    if (url.protocol !== "https:" || url.hostname !== (row.target === "github" ? "github.com" : "linear.app") || url.port || url.username || url.password || url.search || url.hash) throw new Error("Invalid issue link");
    if (row.target === "github" ? !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/issues\/[1-9]\d*$/.test(url.pathname) || url.pathname.split("/").pop() !== row.issueId : !/^\/[^/]+\/issue\/[A-Za-z0-9]+-\d+(?:\/[^/]*)?$/.test(url.pathname)) throw new Error("Invalid issue link");
  } else if (row.issueId !== null || row.issueUrl !== null) throw new Error("Unverified issue link");
  return { app: row.app, reportId: row.reportId, target: row.target, state: row.state, issueId: row.issueId, issueUrl: row.issueUrl };
}
