import type { EditorState, MdfnDocument, MdfnExtension, MdfnJsonValue } from "@mdfn/core";
import { parseMarkdown, serializeMarkdown, type MarkdownOptions } from "@mdfn/markdown";
import { renderHtml, type RenderPolicy } from "@mdfn/render";

export interface PreservationFixture {
  readonly id: string;
  readonly source: string;
  readonly options?: MarkdownOptions;
}

export interface ConformanceFinding {
  readonly code: string;
  readonly fixture: string;
  readonly message: string;
}

export interface ConformanceResult {
  readonly ok: boolean;
  readonly passed: number;
  readonly failed: number;
  readonly findings: readonly ConformanceFinding[];
}

export function runPreservationCorpus(fixtures: readonly PreservationFixture[]): ConformanceResult {
  const findings: ConformanceFinding[] = [];
  let passed = 0;
  for (const fixture of fixtures) {
    try {
      const parsed = parseMarkdown(fixture.source, fixture.options);
      const serialized = serializeMarkdown({ document: parsed.document, originalSource: fixture.source, options: fixture.options });
      if (serialized.markdown !== fixture.source) {
        findings.push({ code: "MDFN_CONFORMANCE_NO_EDIT_CHANGED", fixture: fixture.id, message: "No-edit round trip changed source bytes" });
      } else if (!serialized.preservation.exactUntouched) {
        findings.push({ code: "MDFN_CONFORMANCE_EXACT_NOT_REPORTED", fixture: fixture.id, message: "Exact preservation was not reported" });
      } else {
        passed += 1;
      }
    } catch (error) {
      findings.push({ code: "MDFN_CONFORMANCE_EXCEPTION", fixture: fixture.id, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { ok: findings.length === 0, passed, failed: findings.length, findings };
}

export function certifyExtension(extension: MdfnExtension, fixture: PreservationFixture): ConformanceResult {
  const options = { ...(fixture.options ?? {}), extensions: [...(fixture.options?.extensions && Array.isArray(fixture.options.extensions) ? fixture.options.extensions : []), extension] };
  return runPreservationCorpus([{ ...fixture, options }]);
}

export function runSecurityCorpus(document: MdfnDocument, policy?: RenderPolicy): ConformanceResult {
  const findings: ConformanceFinding[] = [];
  try {
    const result = renderHtml(document, policy);
    if (/<script\b|\son[a-z]+\s*=|javascript:/i.test(result.html)) {
      findings.push({ code: "MDFN_CONFORMANCE_UNSAFE_RENDER", fixture: "security", message: "Unsafe executable output was rendered" });
    }
  } catch (error) {
    findings.push({ code: "MDFN_CONFORMANCE_RENDER_EXCEPTION", fixture: "security", message: error instanceof Error ? error.message : String(error) });
  }
  return { ok: findings.length === 0, passed: findings.length === 0 ? 1 : 0, failed: findings.length, findings };
}

export interface SemanticTraceStep {
  readonly name: string;
  readonly state: MdfnJsonValue;
}

export interface AdapterSemanticTrace {
  readonly schemaVersion: 1;
  readonly framework: "vanilla" | "react" | "svelte" | "solid";
  readonly fixture: string;
  readonly steps: readonly SemanticTraceStep[];
  readonly finalMarkdown: string;
  readonly finalSelection: MdfnJsonValue;
  readonly diagnostics: readonly string[];
  readonly cleanup: { readonly subscriptions: number; readonly mounted: boolean };
}

export function traceState(framework: AdapterSemanticTrace["framework"], fixture: string, states: readonly EditorState[]): AdapterSemanticTrace {
  const final = states.at(-1);
  if (!final) throw new Error("MDFN_TRACE_STATE_MISSING");
  return {
    schemaVersion: 1,
    framework,
    fixture,
    steps: states.map((state) => ({ name: `version:${state.version}`, state: { markdown: state.markdown, dirty: state.dirty } })),
    finalMarkdown: final.markdown,
    finalSelection: final.selection as MdfnJsonValue,
    diagnostics: final.diagnostics.map((entry) => entry.code),
    cleanup: { subscriptions: 0, mounted: false },
  };
}

export function compareSemanticTraces(reference: AdapterSemanticTrace, traces: readonly AdapterSemanticTrace[]): ConformanceResult {
  const findings: ConformanceFinding[] = [];
  for (const trace of traces) {
    const comparable = (value: AdapterSemanticTrace) => JSON.stringify({ steps: value.steps, finalMarkdown: value.finalMarkdown, finalSelection: value.finalSelection, diagnostics: value.diagnostics });
    if (comparable(trace) !== comparable(reference)) findings.push({ code: "MDFN_ADAPTER_TRACE_DIVERGED", fixture: trace.fixture, message: `${trace.framework} diverged from vanilla semantics` });
  }
  return { ok: findings.length === 0, passed: traces.length - findings.length, failed: findings.length, findings };
}

export const representativeCorpus: readonly PreservationFixture[] = Object.freeze([
  { id: "commonmark", source: "# Heading\n\nParagraph with **bold** and *emphasis*.\n" },
  { id: "gfm-table", source: "| A | B |\n| - | - |\n| 1 | 2 |\n" },
  { id: "unicode-crlf", source: "# 日本語\r\n\r\nمرحبا 👋\r\n" },
  { id: "lone-cr", source: "# Heading\r\rParagraph.\r" },
  { id: "opaque-html", source: "<custom-element unsafe=\"no\">value</custom-element>\n" },
  { id: "malformed", source: "```ts\nconst value = 1;\n" },
]);

export function deterministicFuzzCorpus(seed = 0x4d44464e, cases = 100): readonly PreservationFixture[] {
  let value = seed >>> 0;
  const next = (): number => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    return value;
  };
  const tokens = ["plain", "**bold**", "_em_", "`code`", "[link](https://example.com)", "日本語", "👋", "<opaque-tag>", "\\*escaped", "~~strike~~"];
  return Array.from({ length: Math.max(0, cases) }, (_, index) => {
    const lines = Array.from({ length: 1 + (next() % 8) }, () => {
      const prefix = ["", "# ", "- ", "> ", "1. "][next() % 5];
      return `${prefix}${tokens[next() % tokens.length]} ${tokens[next() % tokens.length]}`;
    });
    const newline = next() % 3 === 0 ? "\r\n" : "\n";
    return { id: `fuzz-${seed}-${index}`, source: `${lines.join(newline)}${newline}` };
  });
}

export const MDFN_TESTING_VERSION = "0.1.0" as const;
