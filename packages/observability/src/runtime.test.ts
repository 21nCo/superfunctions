import { describe, expect, it } from "vitest";
import { isBrowserScope } from "./runtime.js";

describe("isBrowserScope", () => {
  it("detects a browser page", () => {
    expect(isBrowserScope({ document: {}, window: {} })).toBe(true);
  });

  it("detects a classic web worker", () => {
    expect(isBrowserScope({ importScripts: () => undefined })).toBe(true);
  });

  it("detects a module worker without importScripts", () => {
    expect(isBrowserScope({ WorkerGlobalScope: function WorkerGlobalScope() {} })).toBe(true);
  });

  it("keeps Node with a DOM shim on the server path", () => {
    expect(isBrowserScope({ process: { versions: { node: "22.0.0" } }, document: {}, window: {} })).toBe(false);
  });

  it("keeps Cloudflare Workers on the server path even with an importScripts stub", () => {
    expect(
      isBrowserScope({ navigator: { userAgent: "Cloudflare-Workers" }, importScripts: () => undefined })
    ).toBe(false);
  });

  it("keeps Deno and Bun on the server path", () => {
    expect(isBrowserScope({ Deno: {}, window: {} })).toBe(false);
    expect(isBrowserScope({ Bun: {} })).toBe(false);
  });

  it("treats a bare server scope and the Node test runtime as non-browser", () => {
    expect(isBrowserScope({})).toBe(false);
    expect(isBrowserScope()).toBe(false);
  });
});
