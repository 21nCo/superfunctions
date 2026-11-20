import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

describe("fromOpenAPI document type", () => {
  it("accepts fresh literals, fromRouter-style and plain interfaces and parsed records without a cast", () => {
    const file = fileURLToPath(new URL("./types/openapi-document.ts", import.meta.url));
    const program = ts.createProgram([file], {
      strict: true,
      noEmit: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
      skipLibCheck: true,
      resolveJsonModule: true,
      esModuleInterop: true,
      baseUrl: fileURLToPath(new URL("..", import.meta.url)),
      paths: { "@mcpfn/core": ["./src/index.ts"] },
    });
    const diagnostics = ts.getPreEmitDiagnostics(program).map((diagnostic) =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    );
    expect(diagnostics).toEqual([]);
  }, 60_000);
});
