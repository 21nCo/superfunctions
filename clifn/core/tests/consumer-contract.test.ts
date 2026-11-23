import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

import { CONSUMER_CONTRACT, CONSUMER_CONTRACT_KEYS, contractKey, type ContractKind } from "./consumer-contract.table.js";
import { scanSource } from "./consumer-import-scanner.js";

// The closed table lives in consumer-contract.table.ts so consumer-scan.test.ts can share it without
// registering these tests twice.

const PACKAGE_NAME = "@clifn/core";
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  exports: Record<string, { types: string; import: string }>;
};
const typeFixturePath = fileURLToPath(new URL("./consumer-contract.test-d.ts", import.meta.url));

function exportsKey(specifier: string): string {
  return specifier === PACKAGE_NAME ? "." : `.${specifier.slice(PACKAGE_NAME.length)}`;
}

function builtEntry(specifier: string): string {
  const entry = packageJson.exports[exportsKey(specifier)];
  if (!entry) {
    throw new Error(`${specifier} is not a subpath in clifn/core/package.json "exports"`);
  }
  const file = fileURLToPath(new URL(entry.import, pathToFileURL(packageRoot)));
  if (!fs.existsSync(file)) {
    throw new Error(`${specifier} resolves to ${entry.import}, which is not built; run \`npm run build -w @clifn/core\` first`);
  }
  return file;
}

function runtimeKind(value: unknown): ContractKind | "missing" {
  if (value === undefined) {
    return "missing";
  }
  if (typeof value === "function") {
    return /^class[\s{]/.test(Function.prototype.toString.call(value)) ? "class" : "function";
  }
  return "const";
}

const runtimeEntries = CONSUMER_CONTRACT.filter((entry) => entry.kind !== "type");
const typeEntries = CONSUMER_CONTRACT.filter((entry) => entry.kind === "type");

describe("@clifn/core consumer contract", () => {
  it("lists each specifier and symbol once, with a published subpath and at least one consumer", () => {
    expect(CONSUMER_CONTRACT_KEYS.size).toBe(CONSUMER_CONTRACT.length);
    for (const entry of CONSUMER_CONTRACT) {
      expect(packageJson.exports, entry.specifier).toHaveProperty([exportsKey(entry.specifier)]);
      expect(entry.usedBy.length, `${entry.specifier} ${entry.symbol}`).toBeGreaterThan(0);
    }
  });

  it.each(runtimeEntries.map((entry) => [`${entry.specifier} ${entry.symbol}`, entry] as const))(
    "exports %s from the built subpath with its recorded kind",
    async (_label, entry) => {
      const fromSpecifier = (await import(entry.specifier)) as Record<string, unknown>;
      const fromBuiltFile = (await import(pathToFileURL(builtEntry(entry.specifier)).href)) as Record<string, unknown>;

      expect(runtimeKind(fromSpecifier[entry.symbol]), `${entry.symbol} from ${entry.specifier}`).toBe(entry.kind);
      // The package name must resolve to the built file named in "exports", which is what consumers load.
      expect(fromSpecifier[entry.symbol]).toBe(fromBuiltFile[entry.symbol]);
    },
  );

  it("checks every type entry in the type-level fixture", () => {
    const fixtureImports = scanSource(fs.readFileSync(typeFixturePath, "utf8"), "consumer-contract.test-d.ts");
    const imported = new Set(
      fixtureImports.flatMap((scanned) => scanned.symbols.map(({ symbol }) => contractKey(scanned.specifier, symbol))),
    );

    const missing = typeEntries
      .map((entry) => contractKey(entry.specifier, entry.symbol))
      .filter((key) => !imported.has(key));
    expect(missing, "type entries that consumer-contract.test-d.ts does not import").toEqual([]);
  });
});
