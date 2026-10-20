import { describe, expect, it, vi } from "vitest";
import { catchFn } from "../src/index.js";

describe("canonical delivery contract", () => {
  it("awaits delivery and redacts context after hooks", async () => {
    const capture = vi.fn(async () => ({integration:{issueId:"one",issueUrl:"https://example.com/issues/one"}}));
    const catcher = catchFn({name:"shop",sessionId:"session",watch:{client:{capture}},beforeSend:event=>({...event,metadata:{password:"secret",valid:true}})});
    const report = await catcher.captureBug({title:"Broken",steps:["Click"],severity:"high"});
    expect(report.integration?.issueId).toBe("one");
    expect(capture.mock.calls[0][0]).toMatchObject({type:"bug_report",app:{name:"shop"},sessionId:"session",report:{title:"Broken",steps:["Click"]},context:{custom:{password:"[REDACTED]",valid:true}}});
    expect(Number.isNaN(Date.parse(capture.mock.calls[0][0].timestamp))).toBe(false);
    catcher.stop();
  });
  it("does not send dropped events and surfaces delivery failures", async () => {
    const capture = vi.fn(async () => {throw new Error("offline");});
    const dropped = catchFn({name:"test",watch:{client:{capture}},beforeSend:()=>null});
    expect((await dropped.captureBug({title:"Drop"})).delivery).toBe("dropped");expect(capture).not.toHaveBeenCalled();dropped.stop();
    const catcher = catchFn({name:"test",watch:{client:{capture}}});
    await expect(catcher.captureBug({title:"Deliver"})).rejects.toThrow("offline");catcher.stop();
  });
  it("uploads large inline attachments and keeps the final payload bounded", async () => {
    const uploadAttachment = vi.fn(async (blob:Blob) => {expect(blob.size).toBe(3);return {url:"https://example.com/file"};});
    const capture = vi.fn(async () => {});
    const catcher = catchFn({name:"test",watch:{client:{capture}},reporter:{maxInlineBytes:1},uploadAttachment});
    const result = await catcher.captureBug({title:"Attachment",attachments:[{id:"file",name:"f",type:"image/png",size:0,dataUrl:"data:image/png;base64,AAEC"}]});
    expect(uploadAttachment).toHaveBeenCalledOnce();
    expect(result.attachments?.[0]).toMatchObject({url:"https://example.com/file",size:3});
    expect(result.attachments?.[0].dataUrl).toBeUndefined();catcher.stop();
  });
});


describe("WatchFn endpoint configuration", () => {
  it("uses the shared browser transport without requiring a DOM", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ accepted: 1 }), { status: 202 }));
    vi.stubGlobal("fetch", fetch);
    const catcher = catchFn({ name: "shop", watch: { endpoint: "https://watch.example/ingest", apiKey: "key", retries: 0 } });
    try {
      expect(catcher.getConfig().maxPayloadSize).toBe(65536);
      const report = await catcher.captureBug({ title: "Endpoint report" });
      expect(report.delivery).toBe("sent");
      expect(fetch).toHaveBeenCalledOnce();
      const [url, request] = fetch.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe("https://watch.example/ingest");
      expect(new Headers(request.headers).get("authorization")).toBe("Bearer key");
      expect(JSON.parse(request.body as string)).toMatchObject([{ id: report.id, type: "bug_report", app: { name: "shop" }, report: { title: "Endpoint report" } }]);
      await catcher.flush();
    } finally { catcher.stop(); vi.unstubAllGlobals(); }
  });
  it("rejects endpoint payload limits larger than WatchFn ingestion accepts", () => {
    expect(() => catchFn({ name: "shop", maxPayloadSize: 65537, watch: { endpoint: "https://watch.example/ingest" } })).toThrow("64 KiB");
  });
});
