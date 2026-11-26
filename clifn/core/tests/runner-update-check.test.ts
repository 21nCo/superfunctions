import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveAppPaths } from "../src/paths.js";
import { runAction, type RunnerOptions } from "../src/runner.js";
import { startUpdateCheck, type UpdateCheckFetch } from "../src/update-check.js";
import { settleCacheWrites } from "../src/update-check-cache.js";

const NOTICE = "Update available: 1.2.0 → 1.3.0 (npm i -g my-cli)";
const tty = { isTTY: true };

function handle(notice: () => Promise<string | null>) {
  return { notice: vi.fn(notice) };
}

function capture() {
  const events: string[] = [];
  const options: RunnerOptions = {
    color: false,
    stdout: (text) => events.push(`out:${text}`),
    stderr: (text) => events.push(`err:${text}`),
  };
  return { events, options };
}

describe("runAction with updateCheck", () => {
  it("writes the notice on stderr after the action's output in text mode and keeps the exit code", async () => {
    const { events, options } = capture();
    const updateCheck = handle(async () => NOTICE);

    const exitCode = await runAction(
      (_options, ctx) => {
        ctx.output.info("done");
        return { exitCode: 3 };
      },
      undefined,
      { ...options, updateCheck }
    );

    expect(exitCode).toBe(3);
    expect(events).toEqual(["out:[i] done\n", `err:${NOTICE}\n`]);
    expect(updateCheck.notice).toHaveBeenCalledTimes(1);
  });

  it("writes the notice after the error of a failed action and keeps exit code 1", async () => {
    const { events, options } = capture();

    const exitCode = await runAction(
      () => {
        throw new Error("boom");
      },
      undefined,
      { ...options, updateCheck: handle(async () => NOTICE) }
    );

    expect(exitCode).toBe(1);
    expect(events).toHaveLength(2);
    expect(events[0]).toContain("boom");
    expect(events[1]).toBe(`err:${NOTICE}\n`);
  });

  it("asks for the notice only after the action has finished", async () => {
    const order: string[] = [];
    await runAction(
      async () => {
        await Promise.resolve();
        order.push("action");
      },
      undefined,
      {
        ...capture().options,
        updateCheck: handle(async () => {
          order.push("notice");
          return null;
        }),
      }
    );
    expect(order).toEqual(["action", "notice"]);
  });

  it.each<[string, RunnerOptions]>([
    ["JSON lines", { mode: "json" }],
    ["a JSON document", { mode: "json", jsonStyle: "document" }],
  ])("never asks for or writes the notice in %s mode", async (_label, mode) => {
    const { events, options } = capture();
    const updateCheck = handle(async () => NOTICE);

    const exitCode = await runAction(() => ({ data: { ok: 1 }, exitCode: 4 }), undefined, {
      ...options,
      ...mode,
      updateCheck,
    });

    expect(exitCode).toBe(4);
    expect(updateCheck.notice).not.toHaveBeenCalled();
    expect(events.join("")).not.toContain("Update available");
  });

  it("never asks for or writes the notice when quiet, and keeps the exit code", async () => {
    const { events, options } = capture();
    const updateCheck = handle(async () => NOTICE);

    const exitCode = await runAction((_options, ctx) => ctx.output.error("failed"), undefined, {
      ...options,
      quiet: true,
      updateCheck,
    });

    expect(exitCode).toBe(0);
    expect(updateCheck.notice).not.toHaveBeenCalled();
    expect(events).toEqual([expect.stringContaining("failed")]);
  });

  it.each<[string, () => Promise<string | null>]>([
    ["null", async () => null],
    ["an empty string", async () => ""],
    ["a rejection", () => Promise.reject(new Error("check failed"))],
    [
      "a synchronous throw",
      () => {
        throw new Error("check failed");
      },
    ],
  ])("writes nothing and keeps the exit code when notice() gives %s", async (_label, notice) => {
    const { events, options } = capture();
    const exitCode = await runAction(() => ({ exitCode: 2 }), undefined, {
      ...options,
      updateCheck: handle(notice),
    });
    expect(exitCode).toBe(2);
    expect(events).toEqual([]);
  });

  it("keeps the exit code when the stderr writer throws on the notice", async () => {
    const exitCode = await runAction(() => ({ exitCode: 5 }), undefined, {
      color: false,
      stderr: () => {
        throw new Error("EPIPE");
      },
      updateCheck: handle(async () => NOTICE),
    });
    expect(exitCode).toBe(5);
  });

  describe("with startUpdateCheck", () => {
    let root: string;

    beforeEach(async () => {
      root = await mkdtemp(path.join(os.tmpdir(), "clifn-runner-update-check-"));
    });

    afterEach(async () => {
      await settleCacheWrites();
      await rm(root, { recursive: true, force: true });
    });

    function start(fetch: UpdateCheckFetch, timeoutMs?: number) {
      return startUpdateCheck({
        name: "my-cli",
        currentVersion: "1.2.0",
        appName: "my-cli",
        env: { XDG_STATE_HOME: root, LOCALAPPDATA: root },
        terminal: { stdin: tty, stdout: tty, stderr: tty },
        fetch,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      });
    }

    it("prints the registry's newer release on stderr", async () => {
      const { events, options } = capture();
      const updateCheck = start(async () => new Response(JSON.stringify({ latest: "1.3.0" })));

      const exitCode = await runAction((_options, ctx) => ctx.output.info("done"), undefined, {
        ...options,
        updateCheck,
      });

      expect(exitCode).toBe(0);
      expect(events).toEqual(["out:[i] done\n", `err:${NOTICE}\n`]);
    });

    it("prints the notice once when one handle is passed to several runAction calls", async () => {
      const { events, options } = capture();
      const fetch = vi.fn<UpdateCheckFetch>(async () => new Response(JSON.stringify({ latest: "1.3.0" })));
      const updateCheck = start(fetch);

      await runAction(() => undefined, undefined, { ...options, updateCheck });
      await runAction(() => undefined, undefined, { ...options, updateCheck });

      expect(events).toEqual([`err:${NOTICE}\n`]);
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("drops a notice that is not ready within the timeout", async () => {
      const { events, options } = capture();
      const updateCheck = start(() => new Promise(() => undefined), 50);

      const started = Date.now();
      const exitCode = await runAction(() => ({ exitCode: 6 }), undefined, { ...options, updateCheck });

      expect(exitCode).toBe(6);
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(events).toEqual([]);
      // The request is aborted at the same deadline and its error is cached in the background.
      await vi.waitFor(async () => {
        const env = { XDG_STATE_HOME: root, LOCALAPPDATA: root };
        const file = path.join(resolveAppPaths("my-cli", { env }).state, "update-check.json");
        const cached = JSON.parse(await readFile(file, "utf8"));
        expect(cached).toMatchObject({ error: true });
      });
    });
  });
});
