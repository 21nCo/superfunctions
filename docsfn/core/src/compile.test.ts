import { describe, expect, it } from "vitest";
import { compileReactContent } from "./compile/react";
import { compileSvelteContent } from "./compile/svelte";
import { compileMarkdown } from "./markdown";

describe("compile pipeline", () => {
  it("compiles fumadocs tabs + mermaid into canonical blocks (TV-MDX-001)", () => {
    const input = `import { Tab, Tabs } from "fumadocs-ui/components/tabs";

# Routes

<Tabs items={["TypeScript", "Python"]}>
  <Tab value="TypeScript">TS body</Tab>
  <Tab value="Python">PY body</Tab>
</Tabs>

\`\`\`mermaid
graph TD;
\`\`\`
`;

    const compiled = compileMarkdown({
      source: input,
      sourcePath: "content/docs/routes.mdx",
      compatPreset: "fumadocs-v15",
    });

    expect(compiled.headings).toEqual([{ level: 1, text: "Routes", slug: "routes" }]);
    expect(compiled.componentsUsed).toEqual(["DocsTab", "DocsTabs", "MermaidBlock"]);
    expect(compiled.blocks.some((block) => block.type === "tabs")).toBe(true);
    expect(compiled.blocks.some((block) => block.type === "mermaid")).toBe(true);
  });

  it("parses callout blocks", () => {
    const compiled = compileMarkdown({
      source: `> [!NOTE] Keep this deterministic\n> across builds.`,
      sourcePath: "content/docs/note.mdx",
    });
    expect(compiled.blocks).toHaveLength(1);
    expect(compiled.blocks[0]).toMatchObject({
      type: "callout",
      kind: "note",
      text: "Keep this deterministic\nacross builds.",
    });
    expect(typeof (compiled.blocks[0] as { html: string }).html).toBe("string");
    expect((compiled.blocks[0] as { html: string }).html.length).toBeGreaterThan(0);
  });

  it("rejects unsupported fumadocs constructs (TV-MIG-001 negative)", () => {
    const input = `import { Accordion } from "fumadocs-ui/components/accordion";\n<Accordion />`;
    expect(() =>
      compileMarkdown({
        source: input,
        sourcePath: "content/docs/bad.mdx",
        compatPreset: "fumadocs-v15",
      })
    ).toThrowError(/DOCS_COMPAT_UNSUPPORTED|Accordion/);
  });

  it("rejects unsupported JSX components in compatibility mode (TV-MDX-001 negative)", () => {
    expect(() =>
      compileMarkdown({
        source: "# Title\n\n<Foo />",
        sourcePath: "content/docs/foo.mdx",
        compatPreset: "fumadocs-v15",
      })
    ).toThrowError(/DOCS_COMPAT_UNSUPPORTED|unsupported JSX component Foo/);
  });

  it("keeps imported non-fumadocs MDX components available in compatibility mode", () => {
    const compiled = compileMarkdown({
      source: `import { DemoCard } from "./DemoCard";\n\n# Demo\n\n<DemoCard />`,
      sourcePath: "content/docs/demo.mdx",
      compatPreset: "fumadocs-v15",
    });

    expect(compiled.blocks.some((block) => block.type === "component" && block.name === "DemoCard")).toBe(true);
  });

  it("rejects unsafe html by default (TV-SEC-001)", () => {
    expect(() =>
      compileMarkdown({
        source: "# Unsafe\n\n<script>alert(1)</script>",
        sourcePath: "content/docs/unsafe.mdx",
      })
    ).toThrowError(/DOCS_HTML_UNSAFE|unsafe HTML/);
  });

  it("fails malformed mdx with DOCS_MDX_COMPILE_FAILED", () => {
    expect(() =>
      compileMarkdown({
        source: `<DocsTabs items={["A"]}>\n<DocsTab value="A">x`,
        sourcePath: "content/docs/malformed.mdx",
      })
    ).toThrowError(/DOCS_MDX_COMPILE_FAILED|missing/);
  });

  it("produces a shared canonical block model for react and svelte compilers", () => {
    const source = `# Shared\n\nParagraph`;
    const reactCompiled = compileReactContent({ source, sourcePath: "content/docs/shared.mdx" });
    const svelteCompiled = compileSvelteContent({ source, sourcePath: "content/docs/shared.mdx" });

    expect(reactCompiled.framework).toBe("react");
    expect(svelteCompiled.framework).toBe("svelte");
    expect(reactCompiled.blocks).toEqual(svelteCompiled.blocks);
    expect(reactCompiled.toc).toEqual(svelteCompiled.toc);
  });
});
