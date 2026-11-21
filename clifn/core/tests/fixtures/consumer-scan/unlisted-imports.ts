// Fixture for consumer-scan.test.ts: imports the consumer contract does not list. Each must fail the scan.
import { createOutput, readIntEnv } from "@clifn/core";
import {
  createPrompt,
} from "@clifn/core/prompt";
import type { OutputOptions } from "@clifn/core/output";
export { formatDiagnosticsJson } from "@clifn/core/diagnostics";
import * as runner from "@clifn/core/runner";

export const used = [createOutput, readIntEnv, createPrompt, runner];
export type Used = OutputOptions;
