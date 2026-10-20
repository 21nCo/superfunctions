import { afterEach, expect, it, vi } from "vitest";
import { BrowserClient, parseBugIssueStatus } from "../src/index";
const ref = { app: "shop", reportId: "one" };
const pending = { ...ref, target: "github", state: "pending", issueId: null, issueUrl: null };
const linked = { ...pending, state: "linked", issueId: "7", issueUrl: "https://github.com/acme/bugs/issues/7" };
afterEach(() => vi.unstubAllGlobals());
it("uses the mounted sibling status route and current authentication without touching delivery", async () => {
  let key = "first"; const fetch = vi.fn(async () => Response.json(pending)); vi.stubGlobal("fetch", fetch);
  const client = new BrowserClient({ endpoint: "https://example.test/watch/ingest", projectId: "shop", autoTrack: false, apiKey: () => key });
  expect(await client.readBugIssueStatus(ref)).toEqual(pending); key = "second";
  expect(await client.readBugIssueStatus(ref)).toEqual(pending);
  expect(fetch.mock.calls[0][0]).toBe("https://example.test/watch/issues/status");
  expect(new Headers(fetch.mock.calls[1][1].headers).get("authorization")).toBe("Bearer second");
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual(ref); expect(client.pendingCount).toBe(0); await client.close();
});
it("requires explicit endpoints for ambiguous routes and handles absence and authorization honestly", async () => {
  const fetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 404 })).mockResolvedValueOnce(new Response(null, { status: 401 })); vi.stubGlobal("fetch", fetch);
  const ambiguous = new BrowserClient({ endpoint: "https://example.test/custom", projectId: "shop", autoTrack: false });
  await expect(ambiguous.readBugIssueStatus(ref)).rejects.toThrow("issueStatusEndpoint"); expect(fetch).not.toHaveBeenCalled();
  const client = new BrowserClient({ endpoint: "https://example.test/custom", issueStatusEndpoint: "https://example.test/status", projectId: "shop", autoTrack: false });
  expect(await client.readBugIssueStatus(ref)).toBeNull(); await expect(client.readBugIssueStatus(ref)).rejects.toMatchObject({ status: 401 });
});
it.each([{ ...linked, reportId: "other" }, { ...linked, app: "other" }, { ...linked, issueUrl: "javascript:alert(1)" }, { ...linked, issueUrl: "https://evil.test/issues/7" }, { ...linked, issueUrl: "https://linear.app/a/issue/ENG-7" }, { ...linked, issueUrl: "https://github.com/acme/bugs/issues/8" }, { ...pending, issueUrl: linked.issueUrl }])("rejects unbound or unsafe status receipts", value => { expect(() => parseBugIssueStatus(value, ref)).toThrow(); });
it("accepts validated GitHub and Linear links", () => {
  expect(parseBugIssueStatus(linked, ref)).toEqual(linked);
  expect(parseBugIssueStatus({ ...linked, target: "linear", issueId: "uuid", issueUrl: "https://linear.app/acme/issue/ENG-7/title" }, ref).target).toBe("linear");
});
it("bounds streaming response bytes and does not retry", async () => {
  const cancel = vi.fn(); const fetch = vi.fn(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(" ".repeat(16385))); }, cancel }), { headers: { "content-type": "application/json" } })); vi.stubGlobal("fetch", fetch);
  const client = new BrowserClient({ endpoint: "https://example.test/ingest", projectId: "shop", autoTrack: false });
  await expect(client.readBugIssueStatus(ref)).rejects.toThrow("too large"); expect(fetch).toHaveBeenCalledTimes(1); expect(cancel).toHaveBeenCalled();
});
it("bounds timeout and close even when fetch ignores its signal", async () => {
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
  const client = new BrowserClient({ endpoint: "https://example.test/ingest", projectId: "shop", autoTrack: false, timeoutMs: 10 });
  await expect(client.readBugIssueStatus(ref)).rejects.toThrow("timed out");
  const waiting = client.readBugIssueStatus(ref); const rejected = expect(waiting).rejects.toThrow("canceled"); await client.close(); await rejected;
});
it("cancels a status body read and ignores a late fetch response", async () => {
  const abort = new AbortController(); let release!: (response: Response) => void;
  vi.stubGlobal("fetch", vi.fn(() => new Promise(resolve => { release = resolve; })));
  const client = new BrowserClient({ endpoint: "https://example.test/ingest", projectId: "shop", autoTrack: false });
  const waiting = client.readBugIssueStatus(ref, { signal: abort.signal }); const rejected = expect(waiting).rejects.toThrow("canceled"); abort.abort(); await rejected;
  const cancel = vi.fn(); release(new Response(new ReadableStream({ cancel }))); await vi.waitFor(() => expect(cancel).toHaveBeenCalled());
});
it("snapshots caller identity while a response is pending", async () => {
  const reference = { ...ref }; let release!: (response: Response) => void;
  vi.stubGlobal("fetch", vi.fn(() => new Promise(resolve => { release = resolve; })));
  const client = new BrowserClient({ endpoint: "https://example.test/ingest", projectId: "shop", autoTrack: false });
  const result = client.readBugIssueStatus(reference); reference.reportId = "changed"; release(Response.json(linked));
  expect(await result).toEqual(linked); await client.close();
});
it("bounds empty stream chunks as well as bytes", async () => {
  const cancel = vi.fn(); vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array()); }, cancel }), { headers: { "content-type": "application/json" } })));
  const client = new BrowserClient({ endpoint: "https://example.test/ingest", projectId: "shop", autoTrack: false });
  await expect(client.readBugIssueStatus(ref)).rejects.toThrow("too large"); expect(cancel).toHaveBeenCalled(); await client.close();
});
