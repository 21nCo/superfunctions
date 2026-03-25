import { describe, expect, it } from "vitest";
import { compileMarkdown, extractHeadings } from "./markdown";

describe("extractHeadings", () => {
  it("extracts deterministic heading anchors from markdown", () => {
    const headings = extractHeadings(`# Heading 1\n\n## Heading 2\n\n### Heading 3\n`);
    expect(headings).toEqual([
      { level: 1, text: "Heading 1", slug: "heading-1" },
      { level: 2, text: "Heading 2", slug: "heading-2" },
      { level: 3, text: "Heading 3", slug: "heading-3" },
    ]);
  });

  it("ignores heading-like lines inside fenced code blocks (TV-MDX-002)", () => {
    const markdown = `## Overview

\`\`\`bash
# Not a heading
\`\`\`

## Overview
`;
    const headings = extractHeadings(markdown);
    expect(headings).toEqual([
      { level: 2, text: "Overview", slug: "overview" },
      { level: 2, text: "Overview", slug: "overview-1" },
    ]);
  });

  it("generates stable unicode slugs for japanese headings (TV-MDX-002)", () => {
    const headings = extractHeadings("## 日本語のヘディング\n");
    expect(headings).toEqual([
      {
        level: 2,
        text: "日本語のヘディング",
        slug: "ri-ben-yu-nohedingu",
      },
    ]);
  });

  it("returns an empty list when there are no headings", () => {
    expect(extractHeadings("just text\n\nno headings")).toEqual([]);
  });
});

describe("compileMarkdown – list blocks", () => {
  it("parses unordered lists as a list block", () => {
    const compiled = compileMarkdown({
      source: "- Install\n- Configure\n- Deploy",
      sourcePath: "content/docs/list.mdx",
    });
    expect(compiled.blocks).toHaveLength(1);
    const block = compiled.blocks[0];
    expect(block.type).toBe("list");
    if (block.type === "list") {
      expect(block.ordered).toBe(false);
      expect(block.items).toEqual([
        { text: "Install" },
        { text: "Configure" },
        { text: "Deploy" },
      ]);
      expect(block.html).toContain("<ul>");
      expect(block.html).toContain("<li>");
      expect(block.html).toContain("Install");
    }
  });

  it("parses ordered lists as a list block", () => {
    const compiled = compileMarkdown({
      source: "1. First\n2. Second\n3. Third",
      sourcePath: "content/docs/ordered.mdx",
    });
    const block = compiled.blocks[0];
    expect(block.type).toBe("list");
    if (block.type === "list") {
      expect(block.ordered).toBe(true);
      expect(block.html).toContain("<ol>");
    }
  });

  it("list no longer merges into a paragraph block", () => {
    const compiled = compileMarkdown({
      source: "- Install\n- Configure\n- Deploy",
      sourcePath: "content/docs/list2.mdx",
    });
    const paragraphs = compiled.blocks.filter((b) => b.type === "paragraph");
    expect(paragraphs).toHaveLength(0);
  });

  it("mixed content: heading + paragraph + list", () => {
    const compiled = compileMarkdown({
      source: "# Steps\n\nDo this:\n\n- Alpha\n- Beta",
      sourcePath: "content/docs/mixed.mdx",
    });
    expect(compiled.blocks[0].type).toBe("heading");
    expect(compiled.blocks[1].type).toBe("paragraph");
    expect(compiled.blocks[2].type).toBe("list");
  });
});

describe("compileMarkdown – html fields", () => {
  it("heading block has an html field with rendered inline markdown", () => {
    const compiled = compileMarkdown({
      source: "## Install **docsfn**",
      sourcePath: "content/docs/h.mdx",
    });
    const block = compiled.blocks[0];
    expect(block.type).toBe("heading");
    if (block.type === "heading") {
      expect(block.html).toContain("<strong>");
      expect(block.html).toContain("docsfn");
    }
  });

  it("paragraph block has an html field with rendered inline markdown", () => {
    const compiled = compileMarkdown({
      source: "Use `npm install` to get started.",
      sourcePath: "content/docs/p.mdx",
    });
    const block = compiled.blocks[0];
    expect(block.type).toBe("paragraph");
    if (block.type === "paragraph") {
      expect(block.html).toContain("<code>");
      expect(block.html).toContain("npm install");
    }
  });

  it("html field sanitizes javascript: href", () => {
    // allowRawHtml bypasses source-level blocking so we can verify output sanitization
    const compiled = compileMarkdown({
      source: "Click [here](javascript:alert(1)) for info.",
      sourcePath: "content/docs/xss.mdx",
      allowRawHtml: true,
    });
    const block = compiled.blocks[0];
    expect(block.type).toBe("paragraph");
    if (block.type === "paragraph") {
      expect(block.html).not.toContain("javascript:");
    }
  });

  it("callout block has an html field", () => {
    const compiled = compileMarkdown({
      source: "> [!TIP] Use **bold** in callouts.",
      sourcePath: "content/docs/callout.mdx",
    });
    const block = compiled.blocks[0];
    expect(block.type).toBe("callout");
    if (block.type === "callout") {
      expect(block.html).toContain("<strong>");
    }
  });
});

describe("compileMarkdown – table blocks", () => {
  it("parses a markdown table as a table block with rendered html", () => {
    const source = `| Name | Value |\n|------|-------|\n| Foo  | Bar   |`;
    const compiled = compileMarkdown({
      source,
      sourcePath: "content/docs/table.mdx",
    });
    expect(compiled.blocks).toHaveLength(1);
    const block = compiled.blocks[0];
    expect(block.type).toBe("table");
    if (block.type === "table") {
      expect(block.html).toContain("<table");
      expect(block.html).toContain("<th");
      expect(block.html).toContain("Name");
      expect(block.html).toContain("Value");
      expect(block.html).toContain("Foo");
    }
  });

  it("table no longer falls into a paragraph block", () => {
    const source = `| A | B |\n|---|---|\n| 1 | 2 |`;
    const compiled = compileMarkdown({
      source,
      sourcePath: "content/docs/table2.mdx",
    });
    const types = compiled.blocks.map((b) => b.type);
    expect(types).not.toContain("paragraph");
    expect(types).toContain("table");
  });

  it("table with alignment syntax produces correct html", () => {
    const source = `| Left | Center | Right |\n|:-----|:------:|------:|\n| a    |   b    |     c |`;
    const compiled = compileMarkdown({
      source,
      sourcePath: "content/docs/table3.mdx",
    });
    const block = compiled.blocks[0];
    expect(block.type).toBe("table");
    if (block.type === "table") {
      expect(block.html).toContain("<table");
    }
  });

  it("table mixed with other blocks parses correctly", () => {
    const source = `## Overview\n\nSome text.\n\n| Key | Value |\n|-----|-------|\n| x   | y     |\n\nMore text.`;
    const compiled = compileMarkdown({
      source,
      sourcePath: "content/docs/mixed.mdx",
    });
    const types = compiled.blocks.map((b) => b.type);
    expect(types).toContain("heading");
    expect(types).toContain("paragraph");
    expect(types).toContain("table");
  });
});
