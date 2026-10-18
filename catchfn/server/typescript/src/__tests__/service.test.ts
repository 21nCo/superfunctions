import { describe, expect, it } from "vitest";
import { memoryAdapter } from "@superfunctions/db/adapters/memory";
import { CatchFnService } from "../service.js";
import { createCatchFnRouter } from "../router.js";
const report = (id = "one", timestamp = 1) => ({id, timestamp, title:"Bug", severity:"high" as const, tags:["ui_%"]});

describe("CatchFn persistence and HTTP contracts", () => {
  it("round trips JSON, prevents scope crossing, and enforces duplicate identity", async () => {
    const db = memoryAdapter();
    const first = new CatchFnService({db, app:"first"});
    const second = new CatchFnService({db, app:"second"});
    const value = {...report(), metadata:{nested:[1,true,{foo:"bar"}], token:"secret"}};
    const saved = await first.createBug(value);
    expect(saved.metadata?.token).toBe("[REDACTED]");
    expect(await first.getBug("one")).toEqual(saved);
    expect(await first.createBug(value)).toEqual(saved);
    await expect(first.createBug({...value,title:"different"})).rejects.toThrow(/already exists/);
    expect(await second.getBug("one")).toBeNull();
    expect(await second.listBugs()).toEqual([]);
    expect(await first.listBugs(50,0,{tags:["ui_%"]})).toHaveLength(1);
    expect(await first.listBugs(50,0,{tags:["ui"]})).toHaveLength(0);
  });
  it("uses received time for retention and keeps cleanup scoped", async () => {
    let now = 0;
    const db = memoryAdapter();
    const first = new CatchFnService({db,app:"first",now:()=>now});
    const second = new CatchFnService({db,app:"second",now:()=>now});
    await first.createBug(report("first",9999999999999));
    await second.createBug(report("second",9999999999999));
    now = 3 * 86400000;
    expect(await first.cleanup(1)).toBe(1);
    expect(await first.getBug("first")).toBeNull();
    expect(await second.getBug("second")).not.toBeNull();
  });
  it("rejects invalid data and pagination before persistence", async () => {
    const service = new CatchFnService({db:memoryAdapter()});
    await expect(service.createBug({...report(),title:" "})).rejects.toThrow(/Invalid/);
    await expect(service.listBugs(-1)).rejects.toThrow(/pagination/);
    await expect(service.listBugs(201)).rejects.toThrow(/pagination/);
    await expect(service.cleanup(-1)).rejects.toThrow(/retentionDays/);
  });
  it("checks auth and classifies malformed body, conflict, and oversized requests", async () => {
    const service = new CatchFnService({db:memoryAdapter()});
    const router = createCatchFnRouter(service,{authorize:req=>req.headers.get("authorization")==="Bearer test",maxBodyBytes:1024});
    const send = (body: string, authorized = true) => router.handle(new Request("http://local/bugs", {method:"POST",headers:{"content-type":"application/json",...(authorized?{authorization:"Bearer test"}:{})},body}));
    expect((await send(JSON.stringify(report()),false)).status).toBe(401);
    expect((await send("{")).status).toBe(400);
    expect((await send(JSON.stringify(report()))).status).toBe(201);
    expect((await send(JSON.stringify({...report(),title:"conflict"}))).status).toBe(409);
    expect((await send(JSON.stringify({...report(),title:"x".repeat(2048)}))).status).toBe(413);
    expect((await router.handle(new Request("http://local/bugs?limit=1oops",{headers:{authorization:"Bearer test"}}))).status).toBe(400);
  });
});
