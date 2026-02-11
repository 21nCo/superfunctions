import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { spawn } from "node:child_process";
import { writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";

const CLI_PATH = resolve(__dirname, "../index.ts");
const TMP_DIR = join(tmpdir(), "contentfn-cli-test-" + Date.now());
const TSX_PATH = resolve(__dirname, "../../../../node_modules/.bin/tsx");

function normalizeSchema(schema: any): any {
  const documentTypes = [...schema.documentTypes].sort((a: any, b: any) =>
    a.name.localeCompare(b.name, "en")
  );
  return {
    version: schema.version,
    documentTypes: documentTypes.map((dt: any) => ({
      name: dt.name,
      fields: [...dt.fields]
        .sort((a: any, b: any) => a.name.localeCompare(b.name, "en"))
        .map((f: any) => ({
          name: f.name,
          type: f.type,
          required: f.required,
          validation: f.validation,
        })),
      meta: dt.meta,
    })),
  };
}

function computeSchemaHash(schema: any): string {
  const normalized = normalizeSchema(schema);
  const canonical = JSON.stringify(normalized);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function runCli(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [TSX_PATH, CLI_PATH, ...args], {
      cwd: TMP_DIR,
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, 20000);

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
  });
}

const validSchema = {
  version: 1,
  documentTypes: [
    {
      name: "post",
      fields: [
        { name: "title", type: { kind: "primitive", type: "string" }, required: true },
      ],
    },
  ],
};

const exportArtifact = {
  dataset: "prod",
  exportedAt: "2026-02-11T00:00:00Z",
  artifact: {
    schema: validSchema,
    documents: {
      published: [
        {
          _id: "post-1",
          _type: "post",
          _rev: "rev_1",
          _createdAt: "2026-02-11T00:00:00Z",
          _updatedAt: "2026-02-11T00:00:00Z",
          title: "Hello",
        },
      ],
      drafts: [],
    },
    assets: [],
    revisions: [],
  },
};

let server: Server;
let serverPort: number;
let serverRequests: Array<{ path: string; body: any }> = [];

function createMockServer(): Promise<{ server: Server; port: number }> {
  return new Promise((res) => {
    const srv = createServer((req: IncomingMessage, resp: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
        const path = req.url ?? "";
        serverRequests.push({ path, body });

        let response: unknown;
        if (path === "/contentfn/schema/upsert") {
          const hash = computeSchemaHash(body.schema);
          response = { ok: true, result: { schemaHash: hash } };
        } else if (path === "/contentfn/datasets/export") {
          response = { ok: true, result: exportArtifact };
        } else if (path === "/contentfn/datasets/import") {
          response = { ok: true, result: { dataset: body.dataset } };
        } else if (path === "/contentfn/docs/get") {
          response = {
            ok: true,
            result: {
              _id: body.id,
              _type: "post",
              _rev: "rev_1",
              _createdAt: "2026-02-11T00:00:00Z",
              _updatedAt: "2026-02-11T00:00:00Z",
              title: "Hello",
            },
          };
        } else {
          response = {
            ok: false,
            error: { code: "INTERNAL_ERROR", message: "Not found", details: {} },
          };
        }
        resp.writeHead(200, { "Content-Type": "application/json" });
        resp.end(JSON.stringify(response));
      });
    });
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address() as { port: number };
      res({ server: srv, port: addr.port });
    });
  });
}

beforeAll(async () => {
  mkdirSync(TMP_DIR, { recursive: true });
  const mock = await createMockServer();
  server = mock.server;
  serverPort = mock.port;
});

afterAll(() => {
  server?.close();
  rmSync(TMP_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  serverRequests = [];
});

describe("TV-CLI-001: schema validate", () => {
  it("exits 0 and prints ok with schema hash", async () => {
    const schemaPath = join(TMP_DIR, "schema.json");
    writeFileSync(schemaPath, JSON.stringify(validSchema), "utf8");

    const { stdout, exitCode } = await runCli(["schema", "validate", schemaPath]);

    expect(exitCode).toBe(0);
    const expectedHash = computeSchemaHash(validSchema);
    expect(stdout.trim()).toBe(`ok ${expectedHash}`);
  });

  it("exits 1 for invalid schema", async () => {
    const schemaPath = join(TMP_DIR, "bad-schema.json");
    writeFileSync(
      schemaPath,
      JSON.stringify({
        version: 1,
        documentTypes: [
          { name: "post", fields: [{ name: "title", type: { kind: "primitive", type: "string" } }] },
          { name: "post", fields: [] },
        ],
      }),
      "utf8"
    );

    const { exitCode, stderr } = await runCli(["schema", "validate", schemaPath]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Error");
  });
});

describe("TV-CLI-002: dataset export + import", () => {
  it("exports a dataset to a file and imports it", async () => {
    const outPath = join(TMP_DIR, "prod.export.json");
    const serverUrl = `http://127.0.0.1:${serverPort}`;

    const exportResult = await runCli([
      "--server", serverUrl,
      "dataset", "export", "--dataset", "prod", "--out", outPath,
    ]);
    expect(exportResult.exitCode).toBe(0);
    expect(exportResult.stdout).toContain("ok");

    const exported = readFileSync(outPath, "utf8");
    expect(() => JSON.parse(exported)).not.toThrow();

    const importResult = await runCli([
      "--server", serverUrl,
      "dataset", "import", "--dataset", "prod2", "--in", outPath,
    ]);
    expect(importResult.exitCode).toBe(0);
    expect(importResult.stdout).toContain("ok");
  });
});

describe("TV-CLI-003: invalid CLI input", () => {
  it("exits non-zero when schema file is missing", async () => {
    const { exitCode, stderr } = await runCli(["schema", "validate", "./missing.json"]);
    expect(exitCode).not.toBe(0);
    expect(stderr.length).toBeGreaterThan(0);
  });

  it("exits non-zero when import file is missing", async () => {
    const serverUrl = `http://127.0.0.1:${serverPort}`;
    const { exitCode, stderr } = await runCli([
      "--server", serverUrl,
      "dataset", "import", "--dataset", "prod", "--in", "./missing.json",
    ]);
    expect(exitCode).not.toBe(0);
    expect(stderr.length).toBeGreaterThan(0);
  });
});

describe("schema upsert via server", () => {
  it("upserts schema and prints ok with hash", async () => {
    const schemaPath = join(TMP_DIR, "schema-upsert.json");
    writeFileSync(schemaPath, JSON.stringify(validSchema), "utf8");
    const serverUrl = `http://127.0.0.1:${serverPort}`;

    const { stdout, exitCode } = await runCli([
      "--server", serverUrl,
      "schema", "upsert", "--dataset", "prod", "--file", schemaPath,
    ]);

    expect(exitCode).toBe(0);
    const expectedHash = computeSchemaHash(validSchema);
    expect(stdout.trim()).toBe(`ok ${expectedHash}`);
    expect(serverRequests).toHaveLength(1);
    expect(serverRequests[0].path).toBe("/contentfn/schema/upsert");
  });
});

describe("doc get via server", () => {
  it("gets a document and prints JSON", async () => {
    const serverUrl = `http://127.0.0.1:${serverPort}`;
    const { stdout, exitCode } = await runCli([
      "--server", serverUrl,
      "doc", "get", "--dataset", "prod", "--id", "post-1",
    ]);
    expect(exitCode).toBe(0);
    const doc = JSON.parse(stdout);
    expect(doc._id).toBe("post-1");
    expect(doc._type).toBe("post");
  });
});
