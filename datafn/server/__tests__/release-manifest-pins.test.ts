/**
 * DFN-21: exact @datafn pins in companion manifests match the workspace version.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const VERSION_SOURCES = [
  "datafn/core",
  "datafn/client",
  "datafn/server",
  "datafn/cli",
  "datafn/svelte",
  "datafn/extfn",
  "datafn/admin",
  "datafn/swift-bridge",
];

const CHECKED = [
  "datafn/admin",
  "datafn/extfn",
  "datafn/cli",
  "datafn/swift-bridge",
  "datafn/server",
  "datafn/svelte",
];

type Manifest = {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

function readManifest(relativeDir: string): Manifest {
  return JSON.parse(readFileSync(resolve(repoRoot, relativeDir, "package.json"), "utf8")) as Manifest;
}

export function exactInternalPinFindings(
  manifest: Manifest,
  versions: Record<string, string>,
): string[] {
  const findings: string[] = [];
  for (const section of ["dependencies", "devDependencies", "peerDependencies"] as const) {
    const deps = manifest[section] ?? {};
    for (const [name, spec] of Object.entries(deps)) {
      if (!name.startsWith("@datafn/")) continue;
      if (!/^\d+\.\d+\.\d+$/.test(spec)) continue;
      const expected = versions[name];
      if (expected !== undefined && spec !== expected) {
        findings.push(`${section} ${name}@${spec} != ${expected}`);
      }
    }
  }
  return findings;
}

describe("release manifest pins", () => {
  it("flags an older exact internal pin", () => {
    const findings = exactInternalPinFindings(
      { dependencies: { "@datafn/server": "0.1.1", "@superfunctions/admin": "0.1.0" } },
      { "@datafn/server": "0.3.0" },
    );
    expect(findings).toEqual(["dependencies @datafn/server@0.1.1 != 0.3.0"]);
  });

  it("ignores range and workspace specs", () => {
    const findings = exactInternalPinFindings(
      { dependencies: { "@datafn/core": "^0.1.0", "@datafn/client": "workspace:*" } },
      { "@datafn/core": "0.1.3", "@datafn/client": "0.1.10" },
    );
    expect(findings).toEqual([]);
  });

  it("accepts the workspace companion manifests", () => {
    const versions: Record<string, string> = {};
    for (const dir of VERSION_SOURCES) {
      const manifest = readManifest(dir);
      if (manifest.name && manifest.version) versions[manifest.name] = manifest.version;
    }
    const findings = CHECKED.flatMap((dir) =>
      exactInternalPinFindings(readManifest(dir), versions).map((finding) => `${dir}: ${finding}`),
    );
    expect(findings).toEqual([]);
  });
});
