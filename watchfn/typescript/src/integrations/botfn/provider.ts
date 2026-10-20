import type { BotFnIssueRoute, BugIssueLink } from "./types";

export const issueMarker = (id: string) => `<!-- watchfn-bug:${id} -->`;
export function issueBody(event: Record<string, any>, id: string): string {
  const report = event.report;
  const clean = (value: string) => value.replace(/<!--\s*watchfn-bug:[\s\S]*?-->/g, "[reserved issue marker]");
  return [clean(report.description ?? ""), ...(report.steps?.length ? ["Steps:", ...report.steps.map((step: string, i: number) => `${i + 1}. ${clean(step)}`)] : []),
    `Severity: ${report.severity}`, ...(report.tags?.length ? [`Tags: ${report.tags.map(clean).join(", ")}`] : []), issueMarker(id)].join("\n\n");
}
const githubPath = (route: BotFnIssueRoute) => `/repos/${route.project.split("/").map(encodeURIComponent).join("/")}/issues`;
function githubLink(route: BotFnIssueRoute, value: any, id: string, expected?: string): BugIssueLink {
  if (!value || !Number.isSafeInteger(value.number) || value.number < 1 || (expected && String(value.number) !== expected) || value.pull_request || typeof value.body !== "string" || !value.body.includes(issueMarker(id))) throw new Error("Invalid issue receipt");
  const url = new URL(value.html_url);
  if (url.origin !== "https://github.com" || url.username || url.password || url.search || url.hash || url.pathname !== `/${route.project}/issues/${value.number}`) throw new Error("Invalid issue URL");
  return { issueId: String(value.number), issueUrl: url.toString() };
}
function linearLink(route: BotFnIssueRoute, value: any, id: string, expected?: string): BugIssueLink {
  if (!value || typeof value.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value.id) || (expected && value.id !== expected) || value.team?.id !== route.project || typeof value.description !== "string" || !value.description.includes(issueMarker(id)) || typeof value.identifier !== "string" || !/^[A-Za-z0-9]+-\d+$/.test(value.identifier)) throw new Error("Invalid issue receipt");
  const url = new URL(value.url);
  const segments = url.pathname.split("/");
  if (url.origin !== "https://linear.app" || url.username || url.password || url.search || url.hash || segments.length < 4 || !segments[1] || segments[2] !== "issue" || segments[3] !== value.identifier) throw new Error("Invalid issue URL");
  return { issueId: value.id, issueUrl: url.toString() };
}

/** No automatic create retries: a transport failure can follow a committed remote side effect. */
export async function createBotFnIssue(route: BotFnIssueRoute, event: Record<string, any>, id: string, signal: AbortSignal): Promise<BugIssueLink> {
  const description = issueBody(event, id);
  if (route.target === "github") {
    const issue = await route.client.request(githubPath(route), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: event.report.title, body: description }), signal, redirect: "error" });
    return githubLink(route, issue, id);
  }
  const result = await route.client.request<any>(`mutation WatchFnCreateIssue($teamId: String!, $title: String!, $description: String!) {
    issueCreate(input: {teamId: $teamId, title: $title, description: $description}) { success issue { id identifier url description team { id } } }
  }`, { teamId: route.project, title: event.report.title, description });
  if (result?.issueCreate?.success !== true) throw new Error("Issue was not acknowledged");
  return linearLink(route, result.issueCreate.issue, id);
}

/** Verify an operator-selected issue against the trusted destination and the stable report marker. */
export async function verifyBotFnIssue(route: BotFnIssueRoute, issueId: string, id: string, signal: AbortSignal): Promise<BugIssueLink> {
  if (route.target === "github") {
    if (!/^[1-9]\d{0,14}$/.test(issueId)) throw new Error("Invalid issue ID");
    return githubLink(route, await route.client.request(`${githubPath(route)}/${issueId}`, { signal, redirect: "error" }), id, issueId);
  }
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(issueId)) throw new Error("Invalid issue ID");
  const result = await route.client.request<any>(`query WatchFnVerifyIssue($id: String!) { issue(id: $id) { id identifier url description team { id } } }`, { id: issueId });
  return linearLink(route, result?.issue, id, issueId);
}
