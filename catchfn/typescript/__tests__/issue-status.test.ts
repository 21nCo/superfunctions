import { expect, it, vi } from "vitest";
import { catchFn } from "../src/index.js";
const pending = { app: "shop", reportId: "one", target: "github" as const, state: "pending" as const, issueId: null, issueUrl: null };
const linked = { ...pending, state: "linked" as const, issueId: "7", issueUrl: "https://github.com/acme/bugs/issues/7" };
it("keeps capture acknowledgment independent and polls only on explicit request", async () => {
  const capture = vi.fn(async () => undefined); const read = vi.fn().mockResolvedValueOnce(pending).mockResolvedValueOnce(linked);
  const catcher = catchFn({ name: "shop", watch: { client: { capture } }, issueStatus: { enabled: true, intervalMs: 100, read } });
  try {
    expect((await catcher.captureBug({ title: "Accepted" })).delivery).toBe("sent"); expect(read).not.toHaveBeenCalled();
    expect(await catcher.pollIssueStatus("one")).toEqual(linked); expect(read).toHaveBeenCalledTimes(2); expect(capture).toHaveBeenCalledTimes(1);
  } finally { catcher.stop(); }
});
it("bounds attempts and stops at reconciliation without resubmitting", async () => {
  const read = vi.fn(async () => pending); const catcher = catchFn({ name: "shop", issueStatus: { enabled: true, maxAttempts: 2, intervalMs: 100, read } });
  try {
    expect(await catcher.pollIssueStatus("one")).toEqual(pending); expect(read).toHaveBeenCalledTimes(2);
    read.mockResolvedValue({ ...pending, state: "reconciliation" } as any);
    expect((await catcher.pollIssueStatus("one"))?.state).toBe("reconciliation"); expect(read).toHaveBeenCalledTimes(3);
  } finally { catcher.stop(); }
});
it("enforces total deadline and stop cancellation when an injected provider ignores AbortSignal", async () => {
  const read = vi.fn(() => new Promise<never>(() => {}));
  const catcher = catchFn({ name: "shop", issueStatus: { enabled: true, timeoutMs: 20, read } });
  await expect(catcher.pollIssueStatus("one")).rejects.toThrow("timed out");
  const waiting = catcher.pollIssueStatus("one"); const rejected = expect(waiting).rejects.toThrow("canceled"); catcher.stop(); await rejected;
  expect(read.mock.calls[1][1].signal.aborted).toBe(true);
});
it("ignores late receipts after cancellation and does not call status callbacks", async () => {
  let release!: (value: any) => void; const onStatus = vi.fn(); const abort = new AbortController();
  const catcher = catchFn({ name: "shop", issueStatus: { enabled: true, read: () => new Promise(resolve => { release = resolve; }) } });
  const waiting = catcher.pollIssueStatus("one", { signal: abort.signal, onStatus }); const rejected = expect(waiting).rejects.toThrow("canceled"); abort.abort(); await rejected;
  release(linked); await Promise.resolve(); expect(onStatus).not.toHaveBeenCalled(); catcher.stop();
});
it.each([{ ...linked, reportId: "other" }, { ...linked, issueUrl: "javascript:alert(1)" }, { ...linked, issueUrl: "https://attacker.test/issue/7" }])("validates injected backend receipts before exposing a link", async value => {
  const catcher = catchFn({ name: "shop", issueStatus: { enabled: true, read: async () => value } });
  try { await expect(catcher.pollIssueStatus("one")).rejects.toThrow(); } finally { catcher.stop(); }
});
it("does not let a provider mutate the expected report identity", async () => {
  const catcher = catchFn({ name: "shop", issueStatus: { enabled: true, read: async ref => { ref.reportId = "other"; return { ...linked, reportId: "other" }; } } });
  try { await expect(catcher.pollIssueStatus("one")).rejects.toThrow(); } finally { catcher.stop(); }
});
it("uses the endpoint BrowserClient status reader with the same API-key authority", async () => {
  const fetch = vi.fn(async () => Response.json(linked)); vi.stubGlobal("fetch", fetch);
  const catcher = catchFn({ name: "shop", watch: { endpoint: "https://example.test/watch/ingest", apiKey: "full-watch-key" }, issueStatus: { enabled: true } });
  try {
    expect(await catcher.pollIssueStatus("one")).toEqual(linked);
    expect(fetch.mock.calls[0][0]).toBe("https://example.test/watch/issues/status");
    expect(new Headers(fetch.mock.calls[0][1].headers).get("authorization")).toBe("Bearer full-watch-key");
  } finally { catcher.stop(); vi.unstubAllGlobals(); }
});
it("validates polling limits and does not silently enable status reads", async () => {
  for (const issueStatus of [{ maxAttempts: 0 }, { intervalMs: 1 }, { timeoutMs: 60001 }, { enabled: "yes" }, { read: false }, null]) expect(() => catchFn({ name: "shop", issueStatus } as any)).toThrow();
  const catcher = catchFn({ name: "shop" }); await expect(catcher.pollIssueStatus("one")).rejects.toThrow("not enabled"); catcher.stop();
});

it("snapshots polling bounds instead of retaining mutable caller configuration", async () => {
  const read = vi.fn(async () => pending); const config = { enabled: true, maxAttempts: 1, read };
  const catcher = catchFn({ name: "shop", issueStatus: config }); config.maxAttempts = 1000;
  expect(await catcher.pollIssueStatus("one")).toEqual(pending); expect(read).toHaveBeenCalledTimes(1); catcher.stop();
});
