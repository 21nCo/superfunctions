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
  type ScaffoldService,
} from "@clifn/core";
import { createDiagnostic, redactValue as redactDiagnosticValue } from "@clifn/core/diagnostics";
import { readStringEnv } from "@clifn/core/env";
import { createExec, type ExecService } from "@clifn/core/exec";
import { createOutput as createSubpathOutput, type OutputService } from "@clifn/core/output";
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
    expectTypeOf<Exclude<RunnerActionResult, void>["exitCode"]>().toEqualTypeOf<number | undefined>();
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
    expectTypeOf<OutputService["json"]>().toEqualTypeOf<(value: unknown) => void>();
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
    expectTypeOf(exec.command).returns.resolves.toHaveProperty("exitCode").toEqualTypeOf<number | null>();
    expectTypeOf(exec.command).returns.resolves.toHaveProperty("stdout").toEqualTypeOf<string>();
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
  });

  it("adds no required member to the exported service interfaces (D2)", () => {
    expectTypeOf<RequiredKeys<ScaffoldService>>().toEqualTypeOf<"apply">();
    expectTypeOf<RequiredKeys<CredentialStore>>().toEqualTypeOf<
      "path" | "getProfile" | "setProfile" | "hasProfile" | "listProfiles" | "removeProfile"
    >();
    expectTypeOf<RequiredKeys<PromptApi>>().toEqualTypeOf<"select" | "multiSelect" | "text" | "confirm">();
  });
});
