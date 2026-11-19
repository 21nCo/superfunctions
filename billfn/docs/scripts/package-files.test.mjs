/**
 * The published BillFn npm packages ship no compiled tests: `npm pack` leaves
 * out `__tests__` directories and `*.test.*` files under `dist`, even when a
 * stale build left them there.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";

const repoRoot = resolve(import.meta.dirname, "../../..");
const releases = JSON.parse(readFileSync(join(repoRoot, "release-packages.json"), "utf8"));
const entries = Array.isArray(releases) ? releases : releases.packages;
const billfnPackages = entries.filter((entry) => entry.path.startsWith("billfn/"));

const planted = [
  "dist/index.js",
  "dist/index.d.ts",
  "dist/__tests__/provider.test.js",
  "dist/__tests__/provider.test.d.ts",
  "dist/__tests__/fixtures/sample.js",
  "dist/nested/__tests__/helper.js",
  "dist/client.test.js",
  "dist/client.test.js.map",
];

test("release-packages.json lists the BillFn npm packages", () => {
  assert.ok(billfnPackages.length >= 7, billfnPackages.map((entry) => entry.name).join(", "));
});

for (const entry of billfnPackages) {
  test(`${entry.name}: npm pack lists no compiled tests`, () => {
    const dir = mkdtempSync(join(tmpdir(), "billfn-pack-"));
    try {
      cpSync(join(repoRoot, entry.path, "package.json"), join(dir, "package.json"));
      for (const file of planted) {
        mkdirSync(dirname(join(dir, file)), { recursive: true });
        writeFileSync(join(dir, file), "export {};\n");
      }
      const output = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: dir, encoding: "utf8" });
      const files = JSON.parse(output)[0].files.map((file) => file.path);
      assert.ok(files.includes("dist/index.js"), files.join("\n"));
      assert.deepEqual(files.filter((file) => /(^|\/)__tests__\/|\.test\./.test(file)), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
