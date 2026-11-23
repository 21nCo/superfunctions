// The deprecated main-entry stdioTarget loads the stdio entry when it opens.
// Closing the client while that import is still pending must abort the
// connect and close cleanly, as it does for a target that opens at once, and
// leave the client able to start a fresh connection.
import { afterEach, describe, expect, it, vi } from "vitest";

const loader = vi.hoisted(() => {
  const open = vi.fn();
  const imports: Array<{ resolve: () => void; reject: (error: unknown) => void }> = [];
  const loadStdioTarget = vi.fn(
    () =>
      new Promise((resolve, reject) => {
        imports.push({ resolve: () => resolve({ stdioTarget: () => ({ open }) }), reject });
      }),
  );
  return { open, imports, loadStdioTarget };
});

vi.mock("../src/load-stdio-target.mjs", () => ({ loadStdioTarget: loader.loadStdioTarget }));

import { createMcpFnClient, stdioTarget } from "../src/index.js";

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("deprecated main-entry stdioTarget", () => {
  afterEach(() => {
    loader.open.mockClear();
    loader.loadStdioTarget.mockClear();
    loader.imports.splice(0);
  });

  it("closes cleanly while the stdio entry is still loading and can reconnect", async () => {
    const cleanup = vi.fn(async () => {});
    const target = stdioTarget({ command: process.execPath });
    const client = createMcpFnClient({ target: { ...target, cleanup } });
    const connecting = client.connect();
    void connecting.catch(() => undefined);
    // Let connect reach the target open, which now waits on the import.
    await settle();
    expect(loader.loadStdioTarget).toHaveBeenCalledTimes(1);

    await expect(client.close()).resolves.toBeUndefined();
    expect(client.state).toBe("closed");
    await expect(connecting).rejects.toMatchObject({ code: "MCPFN_CONNECT_ABORTED" });
    // The cancelled open left no target cleanup pending.
    expect(cleanup).toHaveBeenCalledTimes(1);

    // A later connect starts a fresh attempt without another close.
    const reconnecting = client.connect();
    void reconnecting.catch(() => undefined);
    await settle();
    expect(client.state).toBe("connecting");
    expect(loader.loadStdioTarget).toHaveBeenCalledTimes(2);

    // The first import settling late opens no transport; the second import
    // failing after its connect was cancelled is observed, not unhandled.
    loader.imports[0]!.resolve();
    await expect(client.close()).resolves.toBeUndefined();
    loader.imports[1]!.reject(new Error("late stdio import failure"));
    await expect(reconnecting).rejects.toMatchObject({ code: "MCPFN_CONNECT_ABORTED" });
    await settle();
    expect(loader.open).not.toHaveBeenCalled();
    expect(client.state).toBe("closed");
  });

  it("does not start the import for an already-aborted open", async () => {
    const controller = new AbortController();
    const reason = new Error("aborted before open");
    controller.abort(reason);
    const target = stdioTarget({ command: process.execPath });

    await expect(
      target.open({ requestId: "req-aborted", signal: controller.signal, diagnostic: () => {} }),
    ).rejects.toBe(reason);
    expect(loader.loadStdioTarget).not.toHaveBeenCalled();
  });

  it("does not open the stdio target when the abort lands after the import resolves", async () => {
    const controller = new AbortController();
    const reason = new Error("aborted after the import resolved");
    loader.loadStdioTarget.mockImplementationOnce(() => {
      const loaded = Promise.resolve({ stdioTarget: () => ({ open: loader.open }) });
      // Runs before the open's own reaction to the import, but aborts only
      // after the import has already settled the race with the signal.
      void loaded.then(() => queueMicrotask(() => controller.abort(reason)));
      return loaded;
    });
    const target = stdioTarget({ command: process.execPath });

    await expect(
      target.open({ requestId: "req-late-abort", signal: controller.signal, diagnostic: () => {} }),
    ).rejects.toBe(reason);
    expect(loader.loadStdioTarget).toHaveBeenCalledTimes(1);
    expect(loader.open).not.toHaveBeenCalled();
  });
});
