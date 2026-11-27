/**
 * DFN-19: the cited release and planner jobs pin third-party actions to SHAs.
 * Other jobs in the same files may still float.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SHA_PIN = /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/;
const SETUP_NODE = "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020";
const UPLOAD_ARTIFACT = "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02";

function extractJob(yaml: string, jobName: string): string {
  const lines = yaml.split("\n");
  const start = lines.findIndex((line) => line === `  ${jobName}:`);
  if (start < 0) throw new Error(`job ${jobName} not found`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^  [A-Za-z0-9_-]+:/.test(lines[i] ?? "")) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

function usesTokens(jobBody: string): string[] {
  const tokens: string[] = [];
  for (const line of jobBody.split("\n")) {
    const match = line.match(/^\s*-?\s*uses:\s+(\S+)/);
    if (match?.[1]) tokens.push(match[1]);
  }
  return tokens;
}

describe("workflow action pins", () => {
  it("pins every action in the cited jobs and includes the required SHAs", () => {
    const cases = [
      { file: ".github/workflows/publish-tag.yml", job: "build", sha: SETUP_NODE },
      { file: ".github/workflows/publish-python.yml", job: "build", sha: UPLOAD_ARTIFACT },
      { file: ".github/workflows/ci.yml", job: "plan", sha: SETUP_NODE },
    ];
    for (const item of cases) {
      const yaml = readFileSync(resolve(repoRoot, item.file), "utf8");
      const tokens = usesTokens(extractJob(yaml, item.job));
      expect(tokens.length).toBeGreaterThan(0);
      for (const token of tokens) {
        expect(token, `${item.file} job ${item.job}`).toMatch(SHA_PIN);
      }
      expect(tokens).toContain(item.sha);
    }
  });

  it("rejects a mutable action reference", () => {
    const fixture = [
      "jobs:",
      "  build:",
      "    steps:",
      "      - uses: actions/setup-node@v4",
      "",
    ].join("\n");
    const tokens = usesTokens(extractJob(fixture, "build"));
    expect(tokens).toEqual(["actions/setup-node@v4"]);
    expect(tokens[0]).not.toMatch(SHA_PIN);
  });
});
