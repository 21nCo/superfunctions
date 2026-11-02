import { describe, expect, it } from "vitest";
import { isBrowserScope } from "./runtime.js";

describe("isBrowserScope", () => {
  it("detects a browser page", () => {
    expect(isBrowserScope({ document: {} })).toBe(true);
  });

  it("detects a web worker", () => {
    expect(isBrowserScope({ importScripts: () => undefined })).toBe(true);
  });

  it("treats server runtimes as non-browser", () => {
    expect(isBrowserScope({})).toBe(false);
    expect(isBrowserScope({ navigator: { userAgent: "Cloudflare-Workers" } })).toBe(false);
  });

  it("treats the Node test runtime as non-browser", () => {
    expect(isBrowserScope()).toBe(false);
  });
});
