import type { Diagnostic } from "../src/diagnostics.js";
import { runAction } from "../src/runner.js";

describe("runAction", () => {
  it("provides a parser-agnostic execution context and returns success", async () => {
    const stdout: string[] = [];
    const exitCode = await runAction(
      async (options: { name: string }, ctx) => {
        expect(options.name).toBe("world");
        expect(Object.keys(ctx).sort()).toEqual([
          "cwd",
          "diagnostics",
          "env",
          "exec",
          "nonInteractive",
          "output",
          "scaffold",
        ]);
        expect(ctx.cwd).toBe("repo root");
        expect(ctx.nonInteractive).toBe(true);
        expect(typeof ctx.exec.command).toBe("function");
        expect(typeof ctx.scaffold.apply).toBe("function");
        ctx.output.info(`hello ${options.name}`);
        return undefined;
      },
      { name: "world" },
      {
        cwd: "repo root",
        nonInteractive: true,
        color: false,
        stdout: (text) => stdout.push(text),
      }
    );

    expect(exitCode).toBe(0);
    expect(stdout.join("")).toBe("[i] hello world\n");
  });

  it("returns an explicit action exit code", async () => {
    const exitCode = await runAction(
      () => ({
        exitCode: 7,
      }),
      undefined,
      {
        color: false,
      }
    );

    expect(exitCode).toBe(7);
  });

  it("normalizes thrown errors into exit code 1 and stderr output", async () => {
    const stderr: string[] = [];

    const exitCode = await runAction(
      async () => {
        throw new Error("boom");
      },
      undefined,
      {
        color: false,
        stderr: (text) => stderr.push(text),
      }
    );

    expect(exitCode).toBe(1);
    expect(stderr.join("")).toBe("[x] boom\n");
  });

  it("preserves machine-readable output in json mode", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runAction(
      () => ({
        data: { ok: true, message: "done" },
      }),
      undefined,
      {
        mode: "json",
        stdout: (text) => stdout.push(text),
        stderr: (text) => stderr.push(text),
      }
    );

    expect(exitCode).toBe(0);
    expect(stdout.join("")).toBe('{"ok":true,"message":"done"}\n');
    expect(stderr.join("")).toBe("");
  });

  it("normalizes thrown errors into one json document in machine-readable mode", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runAction(
      async () => {
        throw new Error("boom");
      },
      undefined,
      {
        mode: "json",
        stdout: (text) => stdout.push(text),
        stderr: (text) => stderr.push(text),
      }
    );

    expect(exitCode).toBe(1);
    expect(stdout.join("")).toBe(
      '{"ok":false,"error":{"code":"CLIFN_RUNNER_FAILED","message":"boom"}}\n'
    );
    expect(stderr.join("")).toBe("");
  });

  it("surfaces collected diagnostics to callers through the diagnostics listener", async () => {
    const collected: Diagnostic[][] = [];

    const exitCode = await runAction(
      (options: { name: string }, ctx) => {
        ctx.diagnostics.add({
          code: "ONE",
          severity: "info",
          message: `hello ${options.name}`,
        });
        return {
          diagnostics: [
            {
              code: "TWO",
              severity: "warning",
              message: "second",
            },
          ],
        };
      },
      { name: "world" },
      {
        onDiagnostics: (diagnostics) => collected.push([...diagnostics]),
      }
    );

    expect(exitCode).toBe(0);
    expect(collected).toEqual([
      [
        {
          code: "ONE",
          severity: "info",
          message: "hello world",
        },
        {
          code: "TWO",
          severity: "warning",
          message: "second",
        },
      ],
    ]);
  });
});
