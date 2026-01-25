import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FsContentProvider } from "./index";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("FsContentProvider", () => {
  const testRoot = path.join(__dirname, "__test-fixtures__");

  beforeEach(async () => {
    // Create test fixture directory
    await fs.mkdir(testRoot, { recursive: true });
  });

  afterEach(async () => {
    // Clean up test fixtures
    await fs.rm(testRoot, { recursive: true, force: true });
  });

  it("should list markdown files from docs directory", async () => {
    const docsDir = path.join(testRoot, "docs");
    await fs.mkdir(docsDir, { recursive: true });
    await fs.writeFile(
      path.join(docsDir, "intro.md"),
      `---
title: Introduction
description: Getting started
---

# Introduction

Welcome to the docs.
`
    );

    const provider = new FsContentProvider({ root: testRoot });
    const entries = await provider.list();

    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe("intro.md");
    expect(entries[0].kind).toBe("page");
    expect(entries[0].frontmatter.title).toBe("Introduction");
    expect(entries[0].frontmatter.description).toBe("Getting started");
    expect(entries[0].body).toContain("# Introduction");
    expect(entries[0].body).toContain("Welcome to the docs.");
  });

  it("should list files from nested directories", async () => {
    const docsDir = path.join(testRoot, "docs");
    await fs.mkdir(path.join(docsDir, "guides"), { recursive: true });
    await fs.writeFile(
      path.join(docsDir, "guides", "setup.md"),
      `---
title: Setup Guide
---

Setup instructions.
`
    );

    const provider = new FsContentProvider({ root: testRoot });
    const entries = await provider.list();

    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe("guides/setup.md");
    expect(entries[0].kind).toBe("page");
  });

  it("should list both .md and .mdx files", async () => {
    const docsDir = path.join(testRoot, "docs");
    await fs.mkdir(docsDir, { recursive: true });
    await fs.writeFile(path.join(docsDir, "page1.md"), "# Page 1");
    await fs.writeFile(path.join(docsDir, "page2.mdx"), "# Page 2");

    const provider = new FsContentProvider({ root: testRoot });
    const entries = await provider.list();

    expect(entries).toHaveLength(2);
    const ids = entries.map((e) => e.id).sort();
    expect(ids).toEqual(["page1.md", "page2.mdx"]);
  });

  it("should list blog posts from blog directory", async () => {
    const blogDir = path.join(testRoot, "blog");
    await fs.mkdir(blogDir, { recursive: true });
    await fs.writeFile(
      path.join(blogDir, "my-post.md"),
      `---
title: My Blog Post
date: 2026-01-18
tags: [news, updates]
---

Blog content.
`
    );

    const provider = new FsContentProvider({ root: testRoot });
    const entries = await provider.list();

    const posts = entries.filter((e) => e.kind === "post");
    expect(posts).toHaveLength(1);
    expect(posts[0].id).toBe("my-post.md");
    expect(posts[0].frontmatter.title).toBe("My Blog Post");
    expect(posts[0].frontmatter.tags).toEqual(["news", "updates"]);
  });

  it("should list API specs from api directory", async () => {
    const apiDir = path.join(testRoot, "api");
    await fs.mkdir(apiDir, { recursive: true });
    await fs.writeFile(
      path.join(apiDir, "openapi.json"),
      JSON.stringify({
        openapi: "3.0.0",
        info: { title: "Test API", version: "1.0.0" },
      })
    );

    const provider = new FsContentProvider({ root: testRoot });
    const entries = await provider.list();

    const apis = entries.filter((e) => e.kind === "api");
    expect(apis).toHaveLength(1);
    expect(apis[0].id).toBe("openapi.json");
    expect(apis[0].body).toContain('"openapi"');
  });

  it("should support custom directory names", async () => {
    const customDocsDir = path.join(testRoot, "content");
    await fs.mkdir(customDocsDir, { recursive: true });
    await fs.writeFile(path.join(customDocsDir, "page.md"), "# Page");

    const provider = new FsContentProvider({
      root: testRoot,
      docsDir: "content",
    });
    const entries = await provider.list();

    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("page");
  });

  it("should handle empty directories", async () => {
    await fs.mkdir(path.join(testRoot, "docs"), { recursive: true });
    await fs.mkdir(path.join(testRoot, "blog"), { recursive: true });

    const provider = new FsContentProvider({ root: testRoot });
    const entries = await provider.list();

    expect(entries).toHaveLength(0);
  });

  it("should handle missing frontmatter", async () => {
    const docsDir = path.join(testRoot, "docs");
    await fs.mkdir(docsDir, { recursive: true });
    await fs.writeFile(
      path.join(docsDir, "no-frontmatter.md"),
      "# Just a Heading\n\nNo frontmatter here."
    );

    const provider = new FsContentProvider({ root: testRoot });
    const entries = await provider.list();

    expect(entries).toHaveLength(1);
    expect(entries[0].frontmatter).toEqual({});
    expect(entries[0].body).toContain("# Just a Heading");
  });

  it("should preserve filepath in entries", async () => {
    const docsDir = path.join(testRoot, "docs");
    await fs.mkdir(docsDir, { recursive: true });
    await fs.writeFile(path.join(docsDir, "test.md"), "# Test");

    const provider = new FsContentProvider({ root: testRoot });
    const entries = await provider.list();

    expect(entries[0].filepath).toBeDefined();
    expect(entries[0].filepath).toContain("test.md");
  });

  it("should handle YAML API specs", async () => {
    const apiDir = path.join(testRoot, "api");
    await fs.mkdir(apiDir, { recursive: true });
    await fs.writeFile(
      path.join(apiDir, "spec.yaml"),
      `openapi: 3.0.0
info:
  title: YAML API
  version: 1.0.0
`
    );

    const provider = new FsContentProvider({ root: testRoot });
    const entries = await provider.list();

    const apis = entries.filter((e) => e.kind === "api");
    expect(apis).toHaveLength(1);
    expect(apis[0].id).toBe("spec.yaml");
    expect(apis[0].body).toContain("openapi: 3.0.0");
  });

  it("should list all content types together", async () => {
    // Create docs
    const docsDir = path.join(testRoot, "docs");
    await fs.mkdir(docsDir, { recursive: true });
    await fs.writeFile(path.join(docsDir, "doc.md"), "# Doc");

    // Create blog
    const blogDir = path.join(testRoot, "blog");
    await fs.mkdir(blogDir, { recursive: true });
    await fs.writeFile(path.join(blogDir, "post.md"), "# Post");

    // Create API
    const apiDir = path.join(testRoot, "api");
    await fs.mkdir(apiDir, { recursive: true });
    await fs.writeFile(path.join(apiDir, "api.json"), "{}");

    const provider = new FsContentProvider({ root: testRoot });
    const entries = await provider.list();

    expect(entries).toHaveLength(3);
    const kinds = entries.map((e) => e.kind).sort();
    expect(kinds).toEqual(["api", "page", "post"]);
  });

  it("should handle special characters in filenames", async () => {
    const docsDir = path.join(testRoot, "docs");
    await fs.mkdir(docsDir, { recursive: true });
    await fs.writeFile(path.join(docsDir, "what-is-new.md"), "# What is New?");

    const provider = new FsContentProvider({ root: testRoot });
    const entries = await provider.list();

    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe("what-is-new.md");
  });
});
