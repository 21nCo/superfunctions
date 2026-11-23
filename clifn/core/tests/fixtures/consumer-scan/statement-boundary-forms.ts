// Fixture for consumer-scan.test.ts: statement boundaries and lexer states. Each later @clifn/core line must fail.
import { createOutput } from "@clifn/core";
export { createOutput as out }
import { readIntEnv } from "@clifn/core";
export type { RunnerContext as Ctx }
import type { OutputOptions } from "@clifn/core/output";
const quote = /'/; /* p */ import { readNumberEnv } from/**/"@clifn/core/env";
const text = "it's"; const tick = `a ${"\""} b`; const re = /["`]/g; import { createPrompt } from "@clifn/core/prompt";
/* "unbalanced ' quote */ import {
  formatDiagnosticsJson, // a 'quote' and a "quote"
} from "@clifn/core/diagnostics";
import core = require("@clifn/core");
const literal = `
import { fake } from "@clifn/core/`; import { readStringEnv } from "@clifn/core";

export const used = [quote, text, tick, re, readIntEnv, readNumberEnv, createPrompt, formatDiagnosticsJson, core, literal, readStringEnv];
export type Used = OutputOptions;
