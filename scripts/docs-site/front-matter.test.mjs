import { describe, expect, it } from "vitest";
import matter from "gray-matter";
import { assertYamlFrontMatter, frontMatterLanguage } from "./front-matter.mjs";

const accepted = [
  ["plain Markdown", "# Title\n\nBody"],
  ["empty source", ""],
  ["default delimiter", "---\ntitle: Plain\n---\nBody"],
  ["default delimiter with CRLF", "---\r\ntitle: Plain\r\n---\r\nBody"],
  ["BOM before the default delimiter", "﻿---\ntitle: Plain\n---\nBody"],
  ["explicit yaml", "---yaml\ntitle: Explicit\n---\nBody"],
  ["explicit padded uppercase YAML", "--- YAML \ntitle: Explicit\n---\nBody"],
  ["explicit yml", "---yml\r\ntitle: Explicit\r\n---\r\nBody"],
  ["a thematic break is not front matter", "----js\nnot front matter"],
];
const rejected = [
  ["js", "---js\n({ title: 'x' })\n---\nBody", "js"],
  ["javascript", "---javascript\n({ title: 'x' })\n---\nBody", "javascript"],
  ["uppercase JS with CRLF", "--- JS \r\n({ title: 'x' })\r\n---\r\nBody", "JS"],
  ["coffee", "---coffee\ntitle: 'x'\n---\nBody", "coffee"],
  ["json", '---json\n{"title":"x"}\n---\nBody', "json"],
  ["an unregistered engine", "---toml\ntitle = 'x'\n---\nBody", "toml"],
  ["an object prototype key", "---constructor\ntitle: x\n---\nBody", "constructor"],
  ["a label after a BOM", "﻿---js\n({ title: 'x' })\n---\nBody", "js"],
  ["an empty js block", "---js\n---\nBody", "js"],
  ["a label without a newline, sliced like gray-matter", "---yaml", "yam"],
];

describe("YAML-only front matter policy", () => {
  it.each(accepted)("accepts %s", (_name, source) => {
    expect(() => assertYamlFrontMatter(source, "docs/page.md")).not.toThrow();
  });

  it.each(rejected)("rejects %s before parsing", (_name, source, label) => {
    expect(() => assertYamlFrontMatter(source, "docs/page.md")).toThrow(expect.objectContaining({
      code: "DOCS_FRONTMATTER_UNSUPPORTED", label, sourcePath: "docs/page.md",
    }));
  });

  it.each([...accepted, ...rejected].filter(([, source]) => source.startsWith("---") && source.charAt(3) !== "-"))(
    "checks the label gray-matter dispatches for %s", (_name, source) => {
      expect(frontMatterLanguage(source)).toBe(matter.language(source).name);
    },
  );

  it("bounds the label reported in the error", () => {
    expect(() => assertYamlFrontMatter(`---${"x".repeat(500)}\n---\n`, "docs/page.md"))
      .toThrow(/^Unsupported front matter engine "x{64}…" in docs\/page\.md;/);
  });
});
