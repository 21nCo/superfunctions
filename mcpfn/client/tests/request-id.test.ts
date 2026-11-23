import { afterEach, describe, expect, it, vi } from "vitest";

import { createMcpFnClient, customTarget, type McpFnDiagnosticEvent } from "../src/index.js";

async function failedConnectRequestIds(): Promise<string[]> {
  const events: McpFnDiagnosticEvent[] = [];
  const client = createMcpFnClient({
    target: customTarget({ kind: "custom", open: () => { throw new Error("offline"); } }),
    diagnostics: (event) => { events.push(event); },
  });
  await expect(client.connect()).rejects.toMatchObject({ code: "MCPFN_TARGET_OPEN_FAILED" });
  await client.close();
  return [...new Set(events.map((event) => event.requestId))];
}

describe("default request IDs", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("use Web Crypto UUIDs", async () => {
    const randomUUID = vi.spyOn(globalThis.crypto, "randomUUID");
    const ids = await failedConnectRequestIds();
    expect(randomUUID).toHaveBeenCalled();
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    randomUUID.mockRestore();
  });

  it("stay unique without global Web Crypto (Node.js 18 default)", async () => {
    vi.stubGlobal("crypto", undefined);
    const ids = [...await failedConnectRequestIds(), ...await failedConnectRequestIds()];
    expect(ids.length).toBeGreaterThan(1);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^mcpfn-[0-9a-z]+-[0-9a-z]+-[0-9a-z]+$/);
  });

  it("do not collide across separately loaded copies of the client in one millisecond", async () => {
    // An app can load both the ESM and the CJS build; each has its own sequence.
    vi.stubGlobal("crypto", undefined);
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    try {
      const ids: string[] = [];
      for (let copy = 0; copy < 2; copy++) {
        vi.resetModules();
        const isolated = await import("../src/index.js");
        const events: McpFnDiagnosticEvent[] = [];
        const client = isolated.createMcpFnClient({
          target: isolated.customTarget({ kind: "custom", open: () => { throw new Error("offline"); } }),
          diagnostics: (event) => { events.push(event); },
        });
        await expect(client.connect()).rejects.toMatchObject({ code: "MCPFN_TARGET_OPEN_FAILED" });
        await client.close();
        ids.push(events[0]!.requestId);
      }
      expect(ids[0]).not.toBe(ids[1]);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
