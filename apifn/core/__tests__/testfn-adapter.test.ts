import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TestCase } from "@testfn/core";
// Imported through the package export so the test covers the built `./testfn` entry.
import { ApifnTestAdapter } from "@apifn/core/testfn";

const mocks = vi.hoisted(() => {
  return {
    readCollection: vi.fn(),
    runCollection: vi.fn(),
  };
});

vi.mock("@apifn/collections", () => ({
  readCollection: mocks.readCollection,
  runCollection: mocks.runCollection,
}));

describe("ApifnTestAdapter", () => {
  let workdir: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (workdir) rmSync(workdir, { recursive: true, force: true });
    workdir = undefined;
  });

  it("TV-TESTFN-001: exposes apifn adapter identity", () => {
    const adapter = new ApifnTestAdapter();

    expect(adapter.name).toBe("apifn");
    expect(adapter.supports("apifn")).toBe(true);
    expect(adapter.supports("APIFN")).toBe(true);
    expect(adapter.supports("vitest")).toBe(false);
  });

  it("TV-TESTFN-002: discovers request-level test cases from opencollection directories", async () => {
    // The built entry bundles fast-glob, so discovery runs against a real directory.
    workdir = realpathSync(mkdtempSync(path.join(tmpdir(), "apifn-testfn-adapter-")));
    const orders = path.join(workdir, "orders");
    mkdirSync(orders);
    writeFileSync(path.join(orders, "opencollection.yml"), "info:\n  name: Orders API\n");
    const adapter = new ApifnTestAdapter();
    mocks.readCollection.mockResolvedValue({
      info: { name: "Orders API" },
      environments: {},
      items: [
        { kind: "request", name: "List Orders" },
        {
          kind: "folder",
          name: "Auth",
          children: [{ kind: "request", name: "Login" }],
        },
      ],
    });

    // Glob patterns use forward slashes (a backslash is a glob escape), and fast-glob returns
    // forward-slash paths, so compare paths in that form on every platform.
    const toPosix = (value: string) => value.replaceAll("\\", "/");
    const tests = await adapter.discover([toPosix(workdir)]);

    expect(mocks.readCollection).toHaveBeenCalledTimes(1);
    expect(toPosix(mocks.readCollection.mock.calls[0]![0] as string)).toBe(toPosix(orders));
    expect(tests).toHaveLength(2);
    expect(tests.map((t: TestCase) => t.name)).toEqual(["List Orders", "Login"]);
    expect(tests[0]?.suite).toBe("Orders API");
    expect(tests[1]?.suite).toBe("Auth");
  });

  it("TV-TESTFN-003: maps collection request results to testfn result format", async () => {
    const adapter = new ApifnTestAdapter();
    mocks.readCollection.mockResolvedValue({
      info: { name: "Orders API" },
      environments: { default: {} },
      items: [],
    });
    mocks.runCollection.mockResolvedValue({
      results: [
        { name: "List Orders", status: "passed", duration: 11, assertions: [] },
        {
          name: "Create Order",
          status: "failed",
          duration: 22,
          assertions: [{ name: "status is 201", passed: false }],
        },
        { name: "Sync Orders", status: "error", duration: 33, assertions: [], error: "socket hang up", statusCode: 500 },
        { name: "Archive Order", status: "skipped", duration: 0, assertions: [] },
      ],
    });

    const tests: TestCase[] = [
      { id: "t1", file: "/tmp/work/orders", name: "List Orders", suite: "Orders API" },
      { id: "t2", file: "/tmp/work/orders", name: "Create Order", suite: "Orders API" },
      { id: "t3", file: "/tmp/work/orders", name: "Sync Orders", suite: "Orders API" },
      { id: "t4", file: "/tmp/work/orders", name: "Archive Order", suite: "Orders API" },
    ];

    const results = await adapter.run(tests, {});

    expect(results).toHaveLength(4);
    expect(results[0]).toMatchObject({ id: "t1", status: "passed", duration: 11 });
    expect(results[1]).toMatchObject({ id: "t2", status: "failed", duration: 22 });
    expect(results[1]?.error?.message).toContain("status is 201");
    expect(results[2]).toMatchObject({ id: "t3", status: "failed", duration: 33 });
    expect(results[2]?.error?.message).toContain("socket hang up");
    expect(results[3]).toMatchObject({ id: "t4", status: "skipped", duration: 0 });
    expect(mocks.runCollection).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      allowScripts: false,
      processEnv: undefined,
    }));
  });

  it("forwards explicit collection trust and environment values", async () => {
    const processEnv = { API_TEST_VALUE: "allowed-value" };
    const adapter = new ApifnTestAdapter({ allowScripts: true, processEnv });
    mocks.readCollection.mockResolvedValue({ environments: { default: {} } });
    mocks.runCollection.mockResolvedValue({ results: [] });

    await adapter.run([{ id: "t1", file: "/tmp/work/orders", name: "List Orders", suite: "Orders API" }], {});

    expect(mocks.runCollection).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      allowScripts: true,
      processEnv,
    }));
  });
});
