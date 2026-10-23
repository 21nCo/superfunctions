# PHASE_06: toImage and ADAPTER_ERROR handling

## Phase goal

Add optional toImage() on ChartAdapterHandle; ensure render() catches adapter mount() throw and returns ADAPTER_ERROR envelope.

## In scope

- ChartAdapterHandle type: optional toImage?(options?: { format?: "png"|"svg"; width?: number; height?: number }): Promise<string>
- At least one adapter (e.g. ECharts) implements toImage: return data URL (PNG) or SVG string via library API (e.g. echartsInstance.getDataURL() or getConnectedDataURL())
- render() already catches throw in mount (Phase 01); verify TV-ENVELOPE-003 passes (mock adapter that throws → ADAPTER_ERROR)
- Tests: TV-TOIMAGE-001, TV-ENVELOPE-003

## Out of scope

- SSR/Node toImage (optional; only if adapter supports headless)

## Deliverables

- Types: ChartAdapterHandle documents optional toImage
- ECharts adapter: implement toImage() returning Promise<string> (data URL or SVG)
- Carbon/Chart.js: document that toImage is optional; implement if feasible
- Tests: TV-TOIMAGE-001 (adapter with toImage, mount, then toImage() resolves to string), TV-ENVELOPE-003 (adapter throws in mount → ADAPTER_ERROR)

## Requirements covered

- API-008, API-005 (ADAPTER_ERROR)

## Implementation tasks

1. Update ChartAdapterHandle type in SPEC and types: toImage?(options?) => Promise<string>.
2. In ECharts adapter: add toImage(options?) { return Promise.resolve(instance.getDataURL({ type: options?.format === "svg" ? "svg" : "png", ... })); } (or equivalent ECharts API).
3. Ensure Phase 01 render() wraps adapter.mount() in try/catch and returns { ok: false, error: { code: "ADAPTER_ERROR", message, details: { adapter: name } } }.
4. Write test: mock adapter that throws in mount(); render() returns ADAPTER_ERROR envelope (TV-ENVELOPE-003).
5. Write test: ECharts mount, handle.toImage({ format: "png" }) returns Promise resolving to string (TV-TOIMAGE-001).

## Verification steps

- npm test: TV-TOIMAGE-001, TV-ENVELOPE-003 pass.
- Manual: mount ECharts chart, call handle.toImage(), verify string is valid data URL or SVG.

## Stop condition

- toImage optional and implemented for ECharts; ADAPTER_ERROR verified; no regression.
