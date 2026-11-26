import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveAppPaths } from "../src/paths.js";
import { startUpdateCheck, type UpdateCheckFetch } from "../src/update-check.js";
import { settleCacheWrites } from "../src/update-check-cache.js";

// Holds every rename while `gate.hold` is set, to model a slow cache write.
const gate = vi.hoisted(() => ({ hold: false, waiting: [] as Array<() => void> }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (gate.hold) {
        await new Promise<void>((resolve) => gate.waiting.push(resolve));
      }
      return actual.rename(...args);
    },
  };
});

const tty = { isTTY: true };
const NOTICE = "Update available: 1.2.0 → 1.3.0 (npm i -g my-cli)";
let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "clifn-update-check-deadline-"));
});

afterEach(async () => {
  gate.hold = false;
  gate.waiting.splice(0).forEach((release) => release());
  await settleCacheWrites();
  await rm(root, { recursive: true, force: true });
});

describe("startUpdateCheck: a slow cache write", () => {
  it("gives an on-time registry result while the cache write is still running, then records it", async () => {
    gate.hold = true;
    const env = { XDG_STATE_HOME: root, LOCALAPPDATA: root };
    const fetch = vi.fn<UpdateCheckFetch>(async () => new Response(JSON.stringify({ latest: "1.3.0" })));
    const handle = startUpdateCheck({
      name: "my-cli",
      currentVersion: "1.2.0",
      appName: "my-cli",
      env,
      terminal: { stdin: tty, stdout: tty, stderr: tty },
      fetch,
      timeoutMs: 200,
    });

    await expect(handle.notice()).resolves.toBe(NOTICE);
    // The cache write is still held at its rename, well past the 200 ms timeout.
    await vi.waitFor(() => expect(gate.waiting.length).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 250));
    const file = path.join(resolveAppPaths("my-cli", { env }).state, "update-check.json");
    await expect(readFile(file, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(handle.notice()).resolves.toBe(NOTICE);

    gate.hold = false;
    gate.waiting.splice(0).forEach((release) => release());
    await settleCacheWrites();
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ latest: "1.3.0", notifiedAt: expect.any(Number) });
  });
});
