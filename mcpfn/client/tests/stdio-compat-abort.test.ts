// The deprecated main-entry stdioTarget loads the stdio entry when it opens.
// Closing the client while that import is still pending must abort the
// connect and close cleanly, as it does for a target that opens at once.
import { describe, expect, it, vi } from "vitest";

const loader = vi.hoisted(() => {
  let release: (module: unknown) => void = () => {};
  const pending = new Promise((resolve) => { release = resolve; });
  const open = vi.fn();
  return {
    open,
    pending,
    release: () => release({ stdioTarget: () => ({ open }) }),
  };
});

vi.mock("../src/load-stdio-target.mjs", () => ({
  loadStdioTarget: () => loader.pending,
}));

import { createMcpFnClient, stdioTarget } from "../src/index.js";

describe("deprecated main-entry stdioTarget", () => {
  it("closes cleanly while the stdio entry is still loading", async () => {
    const client = createMcpFnClient({ target: stdioTarget({ command: process.execPath }) });
    const connecting = client.connect();
    void connecting.catch(() => undefined);
    // Let connect reach the target open, which now waits on the import.
    await new Promise((resolve) => setTimeout(resolve, 10));

    await expect(client.close()).resolves.toBeUndefined();
    expect(client.state).toBe("closed");
    await expect(connecting).rejects.toMatchObject({ code: "MCPFN_CONNECT_ABORTED" });

    // The import settling afterwards opens no transport.
    loader.release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(loader.open).not.toHaveBeenCalled();
  });
});
