import { runAction, type RunnerOptions } from "../src/runner.js";
import { resolveRunnerOptions, resolveTerminal, type ResolveTerminalOptions } from "../src/terminal.js";

const tty = { isTTY: true };
const pipe = { isTTY: false };
const terminal = { stdin: tty, stdout: tty, stderr: tty };

describe("resolveTerminal (D9)", () => {
  it.each<[string, ResolveTerminalOptions, { color: boolean; interactive: boolean; ci: boolean }]>([
    ["a TTY with no variables", { env: {}, ...terminal }, { color: true, interactive: true, ci: false }],
    ["NO_COLOR=1", { env: { NO_COLOR: "1" }, ...terminal }, { color: false, interactive: true, ci: false }],
    ["NO_COLOR empty (ignored)", { env: { NO_COLOR: "" }, ...terminal }, { color: true, interactive: true, ci: false }],
    ["NO_COLOR beats FORCE_COLOR", { env: { NO_COLOR: "1", FORCE_COLOR: "3" }, ...terminal }, { color: false, interactive: true, ci: false }],
    ["FORCE_COLOR=0 on a TTY", { env: { FORCE_COLOR: "0" }, ...terminal }, { color: false, interactive: true, ci: false }],
    ["FORCE_COLOR=false on a TTY", { env: { FORCE_COLOR: "false" }, ...terminal }, { color: false, interactive: true, ci: false }],
    ["FORCE_COLOR=3 on a pipe", { env: { FORCE_COLOR: "3" }, stdin: pipe, stdout: pipe, stderr: pipe }, { color: true, interactive: false, ci: false }],
    ["FORCE_COLOR=1 on a pipe", { env: { FORCE_COLOR: "1" }, stderr: pipe }, { color: true, interactive: false, ci: false }],
    ["FORCE_COLOR=2 on a pipe", { env: { FORCE_COLOR: "2" }, stderr: pipe }, { color: true, interactive: false, ci: false }],
    ["FORCE_COLOR=true on a pipe", { env: { FORCE_COLOR: "true" }, stderr: pipe }, { color: true, interactive: false, ci: false }],
    ["FORCE_COLOR beats TERM=dumb", { env: { FORCE_COLOR: "1", TERM: "dumb" }, stderr: pipe }, { color: true, interactive: false, ci: false }],
    ["an unknown FORCE_COLOR value falls through", { env: { FORCE_COLOR: "yes" }, stdin: tty, stderr: pipe }, { color: false, interactive: false, ci: false }],
    ["TERM=dumb on a TTY", { env: { TERM: "dumb" }, ...terminal }, { color: false, interactive: true, ci: false }],
    ["a non-TTY stderr", { env: {}, stdin: tty, stdout: tty, stderr: pipe }, { color: false, interactive: false, ci: false }],
    ["a non-TTY stdout only", { env: {}, stdin: tty, stdout: pipe, stderr: tty }, { color: true, interactive: true, ci: false }],
    ["a non-TTY stdin", { env: {}, stdin: pipe, stdout: tty, stderr: tty }, { color: true, interactive: false, ci: false }],
    ["CI=true", { env: { CI: "true" }, ...terminal }, { color: true, interactive: false, ci: true }],
    ["CI=1", { env: { CI: "1" }, ...terminal }, { color: true, interactive: false, ci: true }],
    ["CI=0", { env: { CI: "0" }, ...terminal }, { color: true, interactive: true, ci: false }],
    ["CI=false", { env: { CI: "false" }, ...terminal }, { color: true, interactive: true, ci: false }],
    ["CI empty", { env: { CI: "" }, ...terminal }, { color: true, interactive: true, ci: false }],
    ["CI unset", { env: { OTHER: "1" }, ...terminal }, { color: true, interactive: true, ci: false }],
    ["JSON on", { env: {}, json: true, ...terminal }, { color: true, interactive: false, ci: false }],
    ["streams without isTTY", { env: {}, stdin: {}, stdout: {}, stderr: {} }, { color: false, interactive: false, ci: false }],
  ])("%s", (_label, options, expected) => {
    expect(resolveTerminal(options)).toEqual(expected);
  });

  it("reads process.env and the process streams by default", () => {
    const expectedCi = process.env.CI !== undefined && !["", "0", "false"].includes(process.env.CI);
    expect(resolveTerminal().ci).toBe(expectedCi);
    expect(resolveTerminal({ env: { CI: "true" } }).interactive).toBe(false);
  });
});

describe("resolveRunnerOptions", () => {
  const streams = terminal;

  it("maps no flags on an interactive terminal to text mode with the terminal's colour", () => {
    expect(resolveRunnerOptions({}, { env: {}, streams })).toEqual({
      mode: "text",
      color: true,
      stderrColor: true,
      quiet: false,
      verbose: false,
      nonInteractive: false,
    });
  });

  it("maps --json to document-style JSON, which is never interactive", () => {
    expect(resolveRunnerOptions({ json: true, quiet: true, verbose: true }, { env: {}, streams })).toEqual({
      mode: "json",
      jsonStyle: "document",
      color: true,
      stderrColor: true,
      quiet: true,
      verbose: true,
      nonInteractive: true,
    });
  });

  it.each([
    [{ yes: true }, true],
    [{ nonInteractive: true }, true],
    [{ yes: false, nonInteractive: false }, false],
  ])("maps %j to nonInteractive %s on a terminal", (flags, expected) => {
    expect(resolveRunnerOptions(flags, { env: {}, streams }).nonInteractive).toBe(expected);
  });

  it("is non-interactive in CI and on a piped stdin even without flags", () => {
    expect(resolveRunnerOptions({}, { env: { CI: "true" }, streams }).nonInteractive).toBe(true);
    expect(resolveRunnerOptions({}, { env: {}, streams: { ...streams, stdin: pipe } }).nonInteractive).toBe(true);
  });

  it.each<[boolean | "auto" | undefined, Record<string, string>, boolean]>([
    [true, { NO_COLOR: "1" }, true],
    [false, { FORCE_COLOR: "1" }, false],
    ["auto", { NO_COLOR: "1" }, false],
    ["auto", {}, true],
    [undefined, { TERM: "dumb" }, false],
  ])("uses color flag %j with env %j as color %s", (color, env, expected) => {
    expect(resolveRunnerOptions({ color }, { env, streams }).color).toBe(expected);
  });

  it("counts only true for boolean flags, so parser strings do not switch modes", () => {
    const flags = { json: "false", quiet: "1", verbose: 1, yes: "yes", color: "never" } as unknown as Parameters<
      typeof resolveRunnerOptions
    >[0];
    expect(resolveRunnerOptions(flags, { env: {}, streams })).toEqual({
      mode: "text",
      color: true,
      stderrColor: true,
      quiet: false,
      verbose: false,
      nonInteractive: false,
    });
  });

  it("treats explicitly undefined streams as non-TTY rather than the process streams", () => {
    expect(
      resolveRunnerOptions({}, { env: {}, streams: { stdin: undefined, stdout: undefined, stderr: undefined } })
    ).toMatchObject({ color: false, stderrColor: false, nonInteractive: true });
  });

  const ANSI = /\u001b\[/;
  const mixed = { stdin: tty, stdout: pipe, stderr: tty };

  async function runText(options: RunnerOptions) {
    let stdout = "";
    let stderr = "";
    await runAction(
      async (_options, ctx) => {
        ctx.output.info("info line");
        ctx.output.success("success line");
        ctx.output.warn("warn line");
        ctx.output.error("error line");
      },
      {},
      { ...options, stdout: (text) => (stdout += text), stderr: (text) => (stderr += text) }
    );
    return { stdout, stderr };
  }

  it("keeps ANSI off a piped stdout in text mode and colours a TTY stderr", async () => {
    const options = resolveRunnerOptions({}, { env: {}, streams: mixed });
    expect(options).toMatchObject({ color: false, stderrColor: true });
    const result = await runText(options);
    expect(result.stdout).toContain("info line");
    expect(result.stdout).not.toMatch(ANSI);
    expect(result.stderr).toContain("error line");
    expect(result.stderr).toMatch(ANSI);
  });

  it("leaves both streams plain when stderr is piped, as colour follows stderr (D9)", async () => {
    const options = resolveRunnerOptions({}, { env: {}, streams: { stdin: tty, stdout: tty, stderr: pipe } });
    expect(options).toMatchObject({ color: false, stderrColor: false });
    const result = await runText(options);
    expect(result.stdout).not.toMatch(ANSI);
    expect(result.stderr).not.toMatch(ANSI);
  });

  it.each<[string, boolean | "auto" | undefined, Record<string, string>, typeof mixed, boolean]>([
    ["both streams TTYs", "auto", {}, { ...mixed, stdout: tty }, true],
    ["--color on a piped stdout", true, {}, mixed, true],
    ["FORCE_COLOR=1 on a piped stdout", "auto", { FORCE_COLOR: "1" }, mixed, true],
    ["NO_COLOR beats FORCE_COLOR on TTYs", undefined, { NO_COLOR: "1", FORCE_COLOR: "1" }, { ...mixed, stdout: tty }, false],
    ["--no-color on TTYs", false, {}, { ...mixed, stdout: tty }, false],
  ])("uses colour in text mode for %s as the flags and environment decide", async (_label, color, env, streams, expected) => {
    const options = resolveRunnerOptions({ color }, { env, streams });
    expect(options).toMatchObject({ color: expected, stderrColor: expected });
    const result = await runText(options);
    expect(ANSI.test(result.stdout)).toBe(expected);
    expect(ANSI.test(result.stderr)).toBe(expected);
  });

  it("keeps the stderr-following colour for --json, whose stdout carries only the document", () => {
    expect(resolveRunnerOptions({ json: true }, { env: {}, streams: mixed }).color).toBe(true);
  });

  it("leaves the runner's own colour default unchanged when its options are not resolved", async () => {
    let stdout = "";
    let stderr = "";
    await runAction(
      async (_options, ctx) => {
        ctx.output.info("plain default");
        ctx.output.error("plain error");
      },
      {},
      { stdout: (text) => (stdout += text), stderr: (text) => (stderr += text) }
    );
    expect(stdout).toMatch(ANSI);
    expect(stderr).toMatch(ANSI);
  });

  it("gives stderr the runner's color when stderrColor is not set", async () => {
    const result = await runText({ mode: "text", color: false });
    expect(result.stdout).not.toMatch(ANSI);
    expect(result.stderr).not.toMatch(ANSI);
  });
});
