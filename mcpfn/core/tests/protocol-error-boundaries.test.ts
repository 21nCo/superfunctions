import { afterEach, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { InMemoryTaskStore } from "@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js";
import { CreateTaskResultSchema, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { createMcpFnServer, McpFnRegistry, structuredResult } from "../src/index.js";
import { McpFnError } from "../src/errors.js";
const closeables: Array<{close(): Promise<void>}> = [];
afterEach(async () => { await Promise.all(closeables.splice(0).map(x => x.close())); });

it.each(["list", "context", "task", "resource"])("normalizes internal errors at the %s boundary", async mode => {
  for (const error of [Object.assign(new Error("private database failure"), { code: 11000, data: { secret: "private" } }), new DOMException("private aborted", "AbortError")]) {
    const fail = () => { throw error; };
    const registry = new McpFnRegistry().register({name: "echo", description: "Echo", inputSchema: {type:"object"}, handler: async () => structuredResult({ok:true})});
    if (mode === "task") registry.register({ name: "task", description: "Task", inputSchema: {type:"object"}, execution: {taskSupport:"required"}, handler: async () => structuredResult({}), taskHandler: {createTask: fail} });
    if (mode === "resource") registry.registerResource({ name: "private", uri: "test://private", read: fail });
    const server = createMcpFnServer({info:{name:"error-boundary",version:"1"},registry,
      ...(mode === "task" ? {taskStore:new InMemoryTaskStore()} : {}),
      ...(mode === "context" ? {context:fail} : {}),
      ...(mode === "list" || mode === "task" ? {clientProfiles:{profiles:[],resolveVerifiedIdentity:fail}} : {}),
    });
    const client = new Client({name:"boundary-client",version:"1"});
    const [ct,st]=InMemoryTransport.createLinkedPair(); await server.connect(st); await client.connect(ct); closeables.push(client,server);
    const call = mode === "list" ? client.listTools() : mode === "context" ? client.callTool({name:"echo",arguments:{}}) : mode === "resource" ? client.readResource({uri:"test://private"}) : client.request({method:"tools/call",params:{name:"task",arguments:{},task:{}}},CreateTaskResultSchema);
    await expect(call).rejects.toMatchObject({code:ErrorCode.InternalError, message: "MCP error -32603: Internal error", data:undefined});
  }
});

it("preserves intentional McpFn public messages without backend data", async () => {
  const registry = new McpFnRegistry().registerResource({name:"public",uri:"test://public",read:()=>{throw new McpFnError("EXPECTED", "Public explanation", {secret:"private"});}});
  const server=createMcpFnServer({info:{name:"public-error",version:"1"},registry});
  const client=new Client({name:"client",version:"1"}); const[ct,st]=InMemoryTransport.createLinkedPair(); await server.connect(st);await client.connect(ct);closeables.push(client,server);
  await expect(client.readResource({uri:"test://public"})).rejects.toMatchObject({code:ErrorCode.InternalError,message:"MCP error -32603: Public explanation",data:undefined});
});
