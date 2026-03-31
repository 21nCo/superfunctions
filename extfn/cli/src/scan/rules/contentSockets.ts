import { createScanFinding, type ScanRule } from '../report.js';

const SOCKET_PATTERN = /\bnew WebSocket\s*\(|\bnew EventSource\s*\(/;

export const contentSocketsRule: ScanRule = {
  id: 'SCAN-SOCKET-001',
  evaluate(input) {
    const contentScriptEntries = readContentScriptEntries(input.manifest);
    if (contentScriptEntries.length === 0) {
      return [];
    }

    return input.files
      .filter((file) => SOCKET_PATTERN.test(file.contents))
      .map((file) =>
        createScanFinding({
          ruleId: 'SCAN-SOCKET-001',
          severity: 'warning',
          category: 'performance',
          actionability: 'enforceable',
          target: input.target,
          file: file.relativePath,
          message:
            'Detected socket-style network APIs in built assets; verify content-script network behavior is necessary and store-compliant.',
        })
      );
  },
};

function readContentScriptEntries(manifest: Record<string, unknown>): unknown[] {
  return Array.isArray(manifest.content_scripts) ? manifest.content_scripts : [];
}
