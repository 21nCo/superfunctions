import { describe, expect, it } from "vitest";
import { extractHeadings } from "./markdown";

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
