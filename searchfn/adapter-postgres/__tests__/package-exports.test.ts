/**
 * The built entry points. `pg` must be imported lazily (only for connectionString) in both builds,
 * and still resolve when the ESM build is loaded by package name in a fresh Node process.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const packageDir = fileURLToPath(new URL("..", import.meta.url));

function run(source: string, inputType: "module") {
  return spawnSync(process.execPath, [`--input-type=${inputType}`, "-e", source], { cwd: packageDir, encoding: "utf8" });
}

const probe = (load: string) => `
  ${load}
  const fake = new m.PostgresAdapter({ driver: { query: async () => ({ rows: [{ doc_id: "5", score: 1 }] }) } });
  const ids = await fake.search({ resource: "r", query: "q" });
  const owned = new m.PostgresAdapter({ connectionString: "postgres://u:secret@127.0.0.1:1/db", retry: { maxRetries: 0 } });
  const error = await owned.search({ resource: "r", query: "q" }).catch((e) => e);
  await owned.dispose();
  console.log(JSON.stringify({ ids, bindings: [typeof m.fromPg, typeof m.fromPostgresJs], code: error.code, message: error.message }));
`;

describe("published entry points", () => {
  beforeAll(() => {
    if (!existsSync(new URL("../dist/index.cjs", import.meta.url))) {
      execFileSync("npx", ["tsup"], { cwd: packageDir, stdio: "ignore" });
    }
  }, 120_000);

  it("does not import pg statically from either build", () => {
    for (const file of ["../dist/index.js", "../dist/index.cjs"]) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(source, file).not.toMatch(/from ['"]pg['"]|require\(['"]pg['"]\)/);
      expect(source, file).toMatch(/import\(['"]pg['"]\)/);
    }
  });

  // Only the ESM build is loaded: the CommonJS build cannot be required on any branch, because
  // @superfunctions/observability is ESM-only with top-level await (ERR_REQUIRE_ASYNC_MODULE).
  it("runs an injected driver and loads pg for connectionString", () => {
    const result = run(probe(`const m = await import("@searchfn/adapter-postgres");`), "module");
    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout.trim());
    expect(output.ids).toEqual([5]);
    expect(output.bindings).toEqual(["function", "function"]);
    expect(output.code).toBe("INTERNAL");
    expect(output.message).toMatch(/^Postgres operation failed: .*ECONNREFUSED/);
    expect(output.message).not.toContain("secret");
  });
});
