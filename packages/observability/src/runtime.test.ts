import { describe, expect, it } from "vitest";
import { isBrowserScope, serverRuntime } from "./runtime.js";

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

  it("keeps navigator-less Cloudflare Workers on the server path", () => {
    expect(
      isBrowserScope({
        WebSocketPair: function WebSocketPair() {},
        WorkerGlobalScope: function WorkerGlobalScope() {},
        importScripts: () => undefined
      })
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

describe("serverRuntime", () => {
  it("reports Node, including Bun and Deno with a Node version", () => {
    expect(serverRuntime({ process: { versions: { node: "22.0.0" } }, document: {} })).toBe("node");
    expect(serverRuntime({ Bun: {}, process: { versions: { node: "22.0.0" } } })).toBe("node");
    expect(serverRuntime()).toBe("node");
  });

  it("reports other server runtimes without a Node version", () => {
    expect(serverRuntime({ Deno: {} })).toBe("server");
    expect(serverRuntime({ navigator: { userAgent: "Cloudflare-Workers" } })).toBe("server");
    expect(serverRuntime({ WebSocketPair: class {}, importScripts: () => undefined })).toBe("server");
  });

  it("reports no server runtime for browsers and bare scopes", () => {
    expect(serverRuntime({ document: {}, window: {} })).toBeUndefined();
    expect(serverRuntime({ WorkerGlobalScope: class {} })).toBeUndefined();
    expect(serverRuntime({})).toBeUndefined();
  });
});
