/**
 * Type-level half of the @clifn/core consumer contract (CLI-11), run by `vitest run` through the
 * typecheck settings in vitest.config.ts. It imports every type row of consumer-contract.table.ts from
 * the built subpath (consumer-contract.test.ts fails when one is missing here) and asserts the option
 * and result shapes the extfn, plugfn, mailfn and devfn CLIs use. The required-member locks enforce D2:
 * a later release may add optional members only.
 */
import { describe, expectTypeOf, it } from "vitest";

import {
  ConfigLoaderError,
  createOutput,
  createScaffold,
  loadConfig,
  redactValue,
  runAction,
  type ConfigLoaderErrorCode,
  type ConfigLoaderOptions,
  type CredentialStore,
  type PromptApi,
  type RunnerContext as RootRunnerContext,
  type ScaffoldOperation,
  type ScaffoldService,
} from "@clifn/core";
import { createDiagnostic, redactValue as redactDiagnosticValue } from "@clifn/core/diagnostics";
import { readStringEnv } from "@clifn/core/env";
import { createExec, type ExecOptions, type ExecResult, type ExecService } from "@clifn/core/exec";
import { createOutput as createSubpathOutput, type OutputService, type OutputTable } from "@clifn/core/output";
import { runAction as runSubpathAction, type RunnerActionResult, type RunnerContext, type RunnerOptions } from "@clifn/core/runner";

type RequiredKeys<T> = { [K in keyof T]-?: {} extends Pick<T, K> ? never : K }[keyof T];

describe("@clifn/core consumer contract types", () => {
  it("keeps the RunnerOptions fields the consumers pass optional and typed", () => {
    expectTypeOf<RequiredKeys<RunnerOptions>>().toEqualTypeOf<never>();
    expectTypeOf<RunnerOptions["mode"]>().toEqualTypeOf<"text" | "json" | undefined>();
    expectTypeOf<RunnerOptions["env"]>().toEqualTypeOf<NodeJS.ProcessEnv | undefined>();
    expectTypeOf<RunnerOptions["stdout"]>().toEqualTypeOf<((text: string) => void) | undefined>();
    expectTypeOf<RunnerOptions["stderr"]>().toEqualTypeOf<((text: string) => void) | undefined>();
    expectTypeOf<RunnerOptions["nonInteractive"]>().toEqualTypeOf<boolean | undefined>();
    expectTypeOf<RunnerOptions["quiet"]>().toEqualTypeOf<boolean | undefined>();
    expectTypeOf<RunnerOptions["verbose"]>().toEqualTypeOf<boolean | undefined>();
    expectTypeOf<RunnerOptions["color"]>().toEqualTypeOf<boolean | undefined>();
  });

  it("keeps RunnerActionResult as void or an optional exit code, data and diagnostics", () => {
    expectTypeOf<void>().toExtend<RunnerActionResult>();
    expectTypeOf<{ exitCode: number }>().toExtend<RunnerActionResult>();
    expectTypeOf<{ data: unknown }>().toExtend<RunnerActionResult>();
    expectTypeOf<{ exitCode: 1; data: { ok: false }; diagnostics: [] }>().toExtend<RunnerActionResult>();
    expectTypeOf<RequiredKeys<Exclude<RunnerActionResult, void>>>().toEqualTypeOf<never>();
    expectTypeOf<Exclude<RunnerActionResult, void>["exitCode"]>().toEqualTypeOf<number | undefined>();
    expectTypeOf<Exclude<RunnerActionResult, void>["data"]>().toEqualTypeOf<unknown>();
    expectTypeOf<Exclude<RunnerActionResult, void>["diagnostics"]>().toEqualTypeOf<
      readonly ReturnType<typeof createDiagnostic>[] | undefined
    >();

    // extfn's build action returns diagnostics it made with createDiagnostic, in a mutable array.
    const diagnostics = [createDiagnostic({ code: "EXAMPLE_CODE", severity: "error", message: "example" })];
    expectTypeOf({ exitCode: 1, diagnostics }).toExtend<RunnerActionResult>();
    expectTypeOf({ data: { ok: true }, diagnostics: diagnostics as readonly (typeof diagnostics)[number][] }).toExtend<
      RunnerActionResult
    >();
  });

  it("keeps runAction callable as the extfn and mailfn CLIs call it", () => {
    expectTypeOf(runAction).toEqualTypeOf(runSubpathAction);
    expectTypeOf(runAction<{ name: string }>)
      .parameter(0)
      .toExtend<(options: { name: string }, context: RunnerContext) => Promise<RunnerActionResult> | RunnerActionResult>();
    expectTypeOf(runAction<{ name: string }>).parameter(2).toEqualTypeOf<RunnerOptions | undefined>();
    expectTypeOf(runAction).returns.toEqualTypeOf<Promise<number>>();
  });

  it("keeps the RunnerContext members the consumers read, from the root and the runner subpath", () => {
    expectTypeOf<RootRunnerContext>().toEqualTypeOf<RunnerContext>();
    expectTypeOf<RequiredKeys<RunnerContext>>().toEqualTypeOf<
      "cwd" | "env" | "output" | "diagnostics" | "exec" | "scaffold" | "nonInteractive"
    >();
    expectTypeOf<RunnerContext["cwd"]>().toEqualTypeOf<string>();
    expectTypeOf<RunnerContext["env"]>().toEqualTypeOf<NodeJS.ProcessEnv>();
    expectTypeOf<RunnerContext["output"]>().toEqualTypeOf<OutputService>();
    expectTypeOf<RunnerContext["exec"]>().toEqualTypeOf<ExecService>();
    expectTypeOf<RunnerContext["nonInteractive"]>().toEqualTypeOf<boolean>();
  });

  it("keeps OutputService and createOutput as the consumers use them", () => {
    expectTypeOf<RequiredKeys<OutputService>>().toEqualTypeOf<
      "mode" | "debug" | "info" | "success" | "warn" | "error" | "json" | "table" | "spinner"
    >();
    expectTypeOf<OutputService["info"]>().toEqualTypeOf<(message: string, details?: unknown) => void>();
    expectTypeOf<OutputService["success"]>().toEqualTypeOf<(message: string, details?: unknown) => void>();
    expectTypeOf<OutputService["warn"]>().toEqualTypeOf<(message: string, details?: unknown) => void>();
    expectTypeOf<OutputService["error"]>().toEqualTypeOf<(message: string, details?: unknown) => void>();
    expectTypeOf<OutputService["json"]>().toEqualTypeOf<(value: unknown) => void>();
    // extfn's build summary table; devfn and mailfn report status with and without details.
    expectTypeOf<Parameters<OutputService["table"]>>().toEqualTypeOf<[input: OutputTable]>();
    expectTypeOf<OutputService["table"]>().returns.toEqualTypeOf<void>();
    expectTypeOf<RequiredKeys<OutputTable>>().toEqualTypeOf<"columns" | "rows">();
    expectTypeOf<OutputTable["columns"]>().toEqualTypeOf<readonly string[]>();
    expectTypeOf<OutputTable["rows"]>().toEqualTypeOf<
      ReadonlyArray<Record<string, string | number | boolean | null | undefined>>
    >();
    const output = {} as OutputService;
    output.table({ columns: ["target", "outputDir"], rows: ["chrome"].map((target) => ({ target, outputDir: "dist" })) });
    output.success("Inbox created");
    output.warn("Scan detected blocking findings.", { blocking: 1 });
    output.error("build failed: example", { code: "EXTFN_BUILD" });
    expectTypeOf(createOutput).toEqualTypeOf(createSubpathOutput);
    expectTypeOf(createOutput).returns.toEqualTypeOf<OutputService>();
    createOutput({ mode: "json", stdout: (_text: string) => {}, stderr: (_text: string) => {}, color: false, quiet: true, verbose: false });
    createOutput();
  });

  it("keeps ExecService and createExec as the extfn CLI uses them", () => {
    expectTypeOf<RequiredKeys<ExecService>>().toEqualTypeOf<"command">();
    expectTypeOf(createExec).returns.toEqualTypeOf<ExecService>();
    const exec = {} as ExecService;
    exec.command("open", ["-a", "Browser", "https://example.test"], { cwd: "/tmp", env: {}, timeoutMs: 1_000 });
    // extfn's vite build streams both channels through callbacks.
    exec.command("npx", ["vite", "build"], {
      cwd: "/tmp",
      env: {},
      streamOutput: true,
      stdout: (chunk) => process.stdout.write(chunk),
      stderr: (chunk) => process.stderr.write(chunk),
      timeoutMs: 120_000,
    });
    expectTypeOf(exec.command).parameter(2).toEqualTypeOf<ExecOptions | undefined>();
    expectTypeOf<RequiredKeys<ExecOptions>>().toEqualTypeOf<never>();
    // extfn passes its sanitized process environment, whose values may be undefined.
    expectTypeOf<ExecOptions["env"]>().toEqualTypeOf<NodeJS.ProcessEnv | undefined>();
    expectTypeOf<ExecOptions["streamOutput"]>().toEqualTypeOf<boolean | undefined>();
    expectTypeOf<ExecOptions["stdout"]>().toEqualTypeOf<((chunk: string) => void) | undefined>();
    expectTypeOf<ExecOptions["stderr"]>().toEqualTypeOf<((chunk: string) => void) | undefined>();
    // extfn's browser launch passes timeoutMs: 10_000; any numeric timeout must stay accepted.
    expectTypeOf<ExecOptions["timeoutMs"]>().toEqualTypeOf<number | undefined>();
    expectTypeOf(exec.command).returns.resolves.toEqualTypeOf<ExecResult>();
    expectTypeOf<ExecResult["exitCode"]>().toEqualTypeOf<number | null>();
    expectTypeOf<ExecResult["stdout"]>().toEqualTypeOf<string>();
    expectTypeOf<ExecResult["stderr"]>().toEqualTypeOf<string>();
  });

  it("keeps ConfigLoaderOptions.exportNames and the loadConfig result the devfn and plugfn packages use", () => {
    expectTypeOf<RequiredKeys<ConfigLoaderOptions<unknown>>>().toEqualTypeOf<never>();
    expectTypeOf<ConfigLoaderOptions<unknown>["exportNames"]>().toEqualTypeOf<readonly string[] | undefined>();
    expectTypeOf<ConfigLoaderOptions<{ a: 1 }>["validate"]>().toEqualTypeOf<
      ((value: unknown, path: string) => { a: 1 }) | undefined
    >();
    loadConfig<{ a: 1 }>({
      cwd: "/repo",
      configPath: "devfn.config.ts",
      candidates: ["devfn.config.ts"],
      exportNames: ["config", "devfnConfig"],
      validate: () => ({ a: 1 }),
    });
    expectTypeOf(loadConfig<{ a: 1 }>).returns.resolves.toEqualTypeOf<{ config: { a: 1 }; path: string }>();
  });

  it("keeps ConfigLoaderError an Error with the codes the devfn config maps", () => {
    expectTypeOf<ConfigLoaderError>().toExtend<Error>();
    expectTypeOf<ConfigLoaderError["code"]>().toEqualTypeOf<ConfigLoaderErrorCode>();
    expectTypeOf<"CLIFN_CONFIG_NOT_FOUND">().toExtend<ConfigLoaderErrorCode>();
  });

  it("keeps the diagnostics, env and scaffold helpers callable as the consumers call them", () => {
    expectTypeOf(redactValue).toEqualTypeOf(redactDiagnosticValue);
    expectTypeOf(redactValue).parameter(0).toEqualTypeOf<unknown>();
    expectTypeOf(redactValue).returns.toEqualTypeOf<unknown>();
    createDiagnostic({ code: "EXTFN_BUILD", severity: "error", message: "failed", path: "src", details: { target: "chrome" } });
    expectTypeOf(readStringEnv("EXTFN_PACKAGE_OUT_DIR", { defaultValue: "artifacts", env: {} })).toEqualTypeOf<string>();
    expectTypeOf(createScaffold).returns.toEqualTypeOf<ScaffoldService>();
    // devfn's init writes its config file (a user-chosen root .ts name, rendered content) under the
    // caller's cwd and fails when it already exists; all three are general strings there, so they are here.
    const scaffold = {} as ScaffoldService;
    const configName: string = "devfn.config.ts";
    const content: string = "export default {};";
    const cwd: string = "/repo";
    expectTypeOf(
      scaffold.apply([{ kind: "write-file", path: configName, content, ifExists: "error" }], { cwd }),
    ).resolves.toExtend<{ written: string[]; skipped: string[] }>();
    expectTypeOf<Extract<ScaffoldOperation, { kind: "write-file" }>["ifExists"]>().toEqualTypeOf<
      "error" | "skip" | "overwrite" | undefined
    >();
    expectTypeOf<Extract<ScaffoldOperation, { kind: "write-file" }>["path"]>().toEqualTypeOf<string>();
    expectTypeOf<Extract<ScaffoldOperation, { kind: "write-file" }>["content"]>().toEqualTypeOf<string>();
  });

  it("adds no required member to the exported service interfaces (D2)", () => {
    expectTypeOf<RequiredKeys<ScaffoldService>>().toEqualTypeOf<"apply">();
    expectTypeOf<RequiredKeys<CredentialStore>>().toEqualTypeOf<
      "path" | "getProfile" | "setProfile" | "hasProfile" | "listProfiles" | "removeProfile"
    >();
    expectTypeOf<RequiredKeys<PromptApi>>().toEqualTypeOf<"select" | "multiSelect" | "text" | "confirm">();
  });
});
