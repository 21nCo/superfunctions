import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TestCase } from "@testfn/core";
// Imported through the package export so the test covers the built `./testfn` entry.
import { ApifnTestAdapter } from "@apifn/core/testfn";

const mocks = vi.hoisted(() => {
  return {
    trustOptions: true,
    readCollection: vi.fn(),
    runCollection: vi.fn(),
  };
});

vi.mock("@apifn/collections", () => ({
  get COLLECTION_RUNNER_TRUST_OPTIONS() { return mocks.trustOptions; },
  readCollection: mocks.readCollection,
  runCollection: mocks.runCollection,
}));

describe("ApifnTestAdapter", () => {
  let workdir: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.trustOptions = true;
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
        { kind: "request", name: "List Orders", path: "list.yml" },
        {
          kind: "folder",
          name: "Auth",
          children: [{ kind: "request", name: "Login", path: "auth/login.yml" }],
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
      items: [
        { kind: "request", name: "List Orders", path: "list.yml" },
        { kind: "request", name: "Create Order", path: "create.yml" },
        { kind: "request", name: "Sync Orders", path: "sync.yml" },
        { kind: "request", name: "Archive Order", path: "archive.yml" },
      ],
    });
    mocks.runCollection.mockResolvedValue({
      results: [
        { path: "list.yml", status: "passed", duration: 11, assertions: [] },
        {
          path: "create.yml",
          status: "failed",
          duration: 22,
          assertions: [{ name: "status is 201", passed: false }],
        },
        { path: "sync.yml", status: "error", duration: 33, assertions: [], error: "socket hang up", statusCode: 500 },
        { path: "archive.yml", status: "skipped", duration: 0, assertions: [] },
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

  it("forwards explicit trust and only includes selected paths", async () => {
    const processEnv = { API_TEST_VALUE: "allowed-value" };
    const adapter = new ApifnTestAdapter({ allowScripts: true, processEnv });
    mocks.readCollection.mockResolvedValue({
      info: { name: "Orders API" },
      environments: { default: {} },
      items: [
        { kind: "request", name: "List Orders", path: "list.yml" },
        { kind: "folder", name: "Scripted", children: [
          { kind: "request", name: "List Orders", path: "scripted/list.yml" },
        ] },
      ],
    });
    mocks.runCollection.mockResolvedValue({ results: [] });

    await adapter.run([{ id: "apifn:cached-selection", file: "/tmp/work/orders", name: "List Orders", suite: "Orders API" }], {});

    expect(mocks.runCollection).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      allowScripts: true,
      processEnv,
      includePaths: ["list.yml"],
    }));
  });

  it("refuses a collection runner that does not enforce explicit trust", async () => {
    mocks.trustOptions = false;
    await expect(new ApifnTestAdapter().run([], {})).rejects.toThrow("@apifn/collections 0.0.5 or later");
    expect(mocks.runCollection).not.toHaveBeenCalled();
  });

  it("skips a deleted request even when another request in the batch fails preflight", async () => {
    mocks.readCollection.mockResolvedValue({
      info: { name: "Orders API" },
      environments: { default: {} },
      items: [{ kind: "request", name: "List Orders", path: "list.yml" }],
    });
    mocks.runCollection.mockRejectedValueOnce(new Error("Collection scripts are disabled"));
    const file = "/tmp/work/orders";
    const results = await new ApifnTestAdapter().run([
      { id: "deleted", file, name: "Deleted Request" },
      { id: "current", file, name: "List Orders" },
    ], {});
    expect(results).toEqual([
      expect.objectContaining({ id: "deleted", status: "skipped" }),
      expect.objectContaining({
        id: "current", status: "failed", error: expect.objectContaining({ message: "Collection scripts are disabled" }),
      }),
    ]);
  });

  it("distinguishes requests with the same display name and refuses ambiguous legacy selections", async () => {
    workdir = realpathSync(mkdtempSync(path.join(tmpdir(), "apifn-testfn-adapter-")));
    writeFileSync(path.join(workdir, "opencollection.yml"), "name: Orders API\n");
    mocks.readCollection.mockResolvedValue({
      info: { name: "Orders API" },
      environments: { default: {} },
      items: [
        { kind: "request", name: "List Orders", path: "plain.yml" },
        { kind: "request", name: "List Orders", path: "scripted.yml" },
      ],
    });
    const adapter = new ApifnTestAdapter();
    const tests = await adapter.discover([workdir.replaceAll("\\", "/")]);
    expect(tests).toHaveLength(2);
    expect(tests[0]?.id).not.toBe(tests[1]?.id);
    mocks.runCollection.mockResolvedValue({
      results: [{ path: "plain.yml", status: "passed", duration: 1, assertions: [] }],
    });
    await expect(adapter.run([tests[0]!], {})).resolves.toEqual([
      expect.objectContaining({ id: tests[0]!.id, status: "passed" }),
    ]);
    expect(mocks.runCollection).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({
      includePaths: ["plain.yml"],
    }));

    await expect(adapter.run([{ ...tests[0]!, id: "legacy-id" }], {})).resolves.toEqual([
      expect.objectContaining({ id: "legacy-id", status: "failed" }),
    ]);
    expect(mocks.runCollection).toHaveBeenCalledTimes(1);

    mocks.readCollection.mockResolvedValue({
      info: { name: "Orders API" },
      environments: { default: {} },
      items: [
        { kind: "request", name: "Renamed", path: "plain.yml" },
        { kind: "request", name: "List Orders", path: "scripted.yml" },
      ],
    });
    await expect(adapter.run([tests[0]!], {})).resolves.toEqual([
      expect.objectContaining({ id: tests[0]!.id, status: "passed" }),
    ]);
    expect(mocks.runCollection).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({
      includePaths: ["plain.yml"],
    }));

    mocks.readCollection.mockResolvedValue({
      info: { name: "Orders API" },
      environments: { default: {} },
      items: [{ kind: "request", name: "List Orders", path: "scripted.yml" }],
    });
    await expect(adapter.run([tests[0]!], {})).resolves.toEqual([
      expect.objectContaining({ id: tests[0]!.id, status: "skipped" }),
    ]);
    expect(mocks.runCollection).toHaveBeenCalledTimes(2);
  });
});
