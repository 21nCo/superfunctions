// Fixture for consumer-scan.test.ts: the same boundaries with contract symbols only; each parses to exactly its symbols.
import { createOutput } from "@clifn/core";
export { createOutput as out }
import { loadConfig } from "@clifn/core";
const quote = /'/; /* p */ import { createExec } from/**/"@clifn/core/exec";
const tick = `a ${"\""} b`; const re = /["`]/g; import { createDiagnostic } from "@clifn/core/diagnostics";
// import { readIntEnv } from "@clifn/core";
/* import { createPrompt } from "@clifn/core/prompt"; */
const embedded = `
import { readNumberEnv } from "@clifn/core/env";
`;
const literal = `
import { fake } from "@clifn/core/`; import { runAction } from "@clifn/core/runner";
const again = `
export { fake } from "@clifn/core/`; export { redactValue } from "@clifn/core/diagnostics";

export const used = [loadConfig, quote, createExec, tick, re, createDiagnostic, embedded, literal, runAction, again];
