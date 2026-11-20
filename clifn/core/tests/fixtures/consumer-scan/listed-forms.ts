// Fixture for consumer-scan.test.ts: every supported static form, importing only contract symbols.
import { createOutput, loadConfig } from "@clifn/core";
import {
  createDiagnostic,
  // a comment inside a multi-line named import
  redactValue as redact,
} from '@clifn/core/diagnostics';
import type { ExecService } from "@clifn/core/exec";
import { runAction, type RunnerContext } from "@clifn/core";
export { readStringEnv } from "@clifn/core/env";
export type {
  RunnerActionResult,
  RunnerOptions,
} from "@clifn/core/runner";
import { ExtfnError } from "@extfn/core";

export const used = [createOutput, loadConfig, createDiagnostic, redact, runAction, ExtfnError];
export type Used = ExecService | RunnerContext;
