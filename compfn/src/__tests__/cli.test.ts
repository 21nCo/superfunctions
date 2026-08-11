import { describe, it, expect, beforeEach } from "vitest";
import { execSync } from "child_process";
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from "fs";
import { resolve, join } from "path";

const CLI_PATH = resolve(__dirname, "../../cli/dist/index.js");
const TEST_DIR = resolve(__dirname, "../../.test-cli");
const CONFIG_PATH = join(TEST_DIR, "compfn.config.json");

function setupTestDir() {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
  mkdirSync(TEST_DIR, { recursive: true });
  
  writeFileSync(
    CONFIG_PATH,
    JSON.stringify({
      database: { type: "memory" },
      namespace: "test",
    })
  );
}

function cleanupTestDir() {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

describe("CLI Tests", () => {
  beforeEach(() => {
    setupTestDir();
  });

  describe("TV-CLI-001: init and run-checks", () => {
    it("init succeeds", () => {
      const output = execSync(`node ${CLI_PATH} init --config ${CONFIG_PATH}`, {
        encoding: "utf-8",
      });
      expect(output).toContain("CompFn initialized successfully");
    });

    it("run-checks runs (with no checks)", () => {
      execSync(`node ${CLI_PATH} init --config ${CONFIG_PATH}`, { encoding: "utf-8" });
      
      const output = execSync(`node ${CLI_PATH} run-checks --config ${CONFIG_PATH}`, {
        encoding: "utf-8",
      });
      expect(output).toContain("No checks to run");
    });
  });

  describe("TV-CLI-002: export and attest", () => {
    it("export writes file", () => {
      execSync(`node ${CLI_PATH} init --config ${CONFIG_PATH}`, { encoding: "utf-8" });

      const outputPath = join(TEST_DIR, "export.json");
      const output = execSync(
        `node ${CLI_PATH} export --output ${outputPath} --config ${CONFIG_PATH}`,
        { encoding: "utf-8" }
      );

      expect(output).toContain("Auditor pack exported");
      expect(existsSync(outputPath)).toBe(true);

      const content = readFileSync(outputPath, "utf-8");
      const parsed = JSON.parse(content);
      expect(parsed).toHaveProperty("exportedAt");
      expect(parsed).toHaveProperty("controls");
      expect(parsed).toHaveProperty("frameworks");
      expect(parsed).toHaveProperty("evidence");
      expect(parsed).toHaveProperty("mapping");
    });

    it("attest creates evidence", async () => {
      execSync(`node ${CLI_PATH} init --config ${CONFIG_PATH}`, { encoding: "utf-8" });

      const { compFn } = await import("compfn");
      const { memoryAdapter } = await import("@superfunctions/db/adapters");
      const { createSchemaIfSupported } = await import("compfn");

      const adapter = memoryAdapter({});
      await createSchemaIfSupported(adapter, { namespace: "test" });

      const api = compFn({
        database: adapter,
        namespace: "test",
      });

      const controlResult = await api.controls.create({
        name: "Test Control",
        description: "Test",
        category: "test",
      });

      expect(controlResult.ok).toBe(true);
      if (!controlResult.ok) throw new Error("Control creation failed");
      
      const controlId = controlResult.result.id;

      const attestResult = await api.evidence.create({
        controlId,
        type: "manual_attestation",
        actorId: "test-user",
        outcome: "pass",
      });

      expect(attestResult.ok).toBe(true);
      if (attestResult.ok) {
        expect(attestResult.result.type).toBe("manual_attestation");
        expect(attestResult.result.controlId).toBe(controlId);
      }
    });
  });
});

describe("CLI Tests (cleanup)", () => {
  it("cleanup test directory", () => {
    cleanupTestDir();
  });
});
