// Fixture for consumer-scan.test.ts: forms a regex-only scanner can miss. Each must fail the scan.
import{readIntEnv}from"@clifn/core";
import {
  // don't drop (x)
  createPrompt,
} from "@clifn/core/prompt";
import {
  // limit=1
  readNumberEnv,
} from "@clifn/core/env";
import {} from "@clifn/core/scaffold";
import "@clifn/core/prompt";
/* a "quoted" comment */ import { formatDiagnosticsText } from "@clifn/core/diagnostics";

export const used = [readIntEnv, createPrompt, readNumberEnv, formatDiagnosticsText];
