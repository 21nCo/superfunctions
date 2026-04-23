import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import {
  createSecurityScanner,
  findingMeetsSeverity,
  formatFindingsJson,
  formatFindingsSarif,
  formatFindingsTable,
  type ScanFormat,
  type SecFnSeverity,
  type SecurityFinding,
} from "@secfn/core";
import { createSecFnRuntime } from "@secfn/runtime";

const execFileAsync = promisify(execFile);

interface ParsedArgs {
  command?: string;
  subcommand?: string;
  values: Record<string, string | boolean>;
  rest: string[];
}

export async function runSecFnCli(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv);
  if (!parsed.command || parsed.values.help) {
    printHelp();
    return;
  }

  if (parsed.command === "scan") {
    await runScan(parsed);
    return;
  }

  if (parsed.command === "env" && parsed.subcommand === "pull") {
    await runEnvPull(parsed);
    return;
  }

  if (parsed.command === "env" && parsed.subcommand === "run") {
    await runEnvRun(parsed);
    return;
  }

  throw new Error(`Unknown command: ${[parsed.command, parsed.subcommand].filter(Boolean).join(" ")}`);
}

export async function runScan(parsed: ParsedArgs): Promise<SecurityFinding[]> {
  const scanner = createSecurityScanner();
  const findings = parsed.values["git-history"]
    ? await scanner.scanGitHistory({
      commits: numberValue(parsed.values.commits, 100),
      branch: stringValue(parsed.values.branch, "HEAD"),
    })
    : parsed.values.staged
      ? await scanStagedFiles(scanner)
    : await scanner.scanDirectory(resolve(stringValue(parsed.values.path, ".")));

  const baseline = await loadBaseline(parsed.values.baseline);
  const filtered = baseline.size > 0
    ? findings.filter((finding) => !baseline.has(finding.fingerprint))
    : findings;

  const format = stringValue(parsed.values.format, "table") as ScanFormat;
  const output = format === "json"
    ? formatFindingsJson(filtered)
    : format === "sarif"
      ? formatFindingsSarif(filtered)
      : formatFindingsTable(filtered);

  if (parsed.values.output) {
    await writeFile(String(parsed.values.output), output);
  } else {
    console.log(output);
  }

  const failOn = parsed.values["fail-on"] as SecFnSeverity | undefined;
  if (failOn && filtered.some((finding) => findingMeetsSeverity(finding, failOn))) {
    process.exitCode = 1;
  }

  return filtered;
}

async function scanStagedFiles(scanner: ReturnType<typeof createSecurityScanner>): Promise<SecurityFinding[]> {
  const { stdout } = await execFileAsync("git", ["diff", "--name-only", "--cached", "--diff-filter=ACMRT"]);
  const files = stdout.split("\n").filter(Boolean).map((file) => resolve(file));
  const findings: SecurityFinding[] = [];
  for (const file of files) {
    try {
      findings.push(...await scanner.scanFile(file));
    } catch {
      // Missing, binary, or unreadable staged paths are ignored.
    }
  }
  return findings;
}

async function runEnvPull(parsed: ParsedArgs): Promise<void> {
  const runtime = runtimeFromArgs(parsed);
  const setName = required(parsed.values.set, "--set");
  const dotenv = await runtime.toDotEnv(setName);
  if (parsed.values.output) {
    await writeFile(String(parsed.values.output), dotenv);
  } else {
    console.log(dotenv);
  }
}

async function runEnvRun(parsed: ParsedArgs): Promise<void> {
  const runtime = runtimeFromArgs(parsed);
  const setName = required(parsed.values.set, "--set");
  const env = await runtime.toEnv(setName);
  const [command, ...args] = parsed.rest;
  if (!command) throw new Error("secfn env run requires a command after --");

  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      env: { ...process.env, ...env },
    });
    child.on("exit", (code) => {
      process.exitCode = code ?? 1;
      resolvePromise();
    });
    child.on("error", reject);
  });
}

function runtimeFromArgs(parsed: ParsedArgs) {
  return createSecFnRuntime({
    endpoint: required(parsed.values.endpoint, "--endpoint"),
    apiKey: required(parsed.values["api-key"], "--api-key"),
    environment: parsed.values.environment as any,
  });
}

function parseArgs(argv: string[]): ParsedArgs {
  const values: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  const restIndex = argv.indexOf("--");
  const beforeRest = restIndex >= 0 ? argv.slice(0, restIndex) : argv;
  const rest = restIndex >= 0 ? argv.slice(restIndex + 1) : [];

  for (let i = 0; i < beforeRest.length; i++) {
    const arg = beforeRest[i];
    if (arg.startsWith("--")) {
      const [rawKey, inline] = arg.slice(2).split("=", 2);
      if (inline !== undefined) {
        values[rawKey] = inline;
      } else if (beforeRest[i + 1] && !beforeRest[i + 1].startsWith("--")) {
        values[rawKey] = beforeRest[++i];
      } else {
        values[rawKey] = true;
      }
    } else {
      positionals.push(arg);
    }
  }

  return {
    command: positionals[0],
    subcommand: positionals[1],
    values,
    rest,
  };
}

async function loadBaseline(value: string | boolean | undefined): Promise<Set<string>> {
  if (!value || typeof value !== "string") return new Set();
  const { readFile } = await import("node:fs/promises");
  const data = JSON.parse(await readFile(value, "utf8")) as
    | { findings?: Array<{ fingerprint?: string }> }
    | Array<{ fingerprint?: string }>;
  const findings = Array.isArray(data) ? data : data.findings ?? [];
  return new Set(findings.map((finding) => finding.fingerprint).filter(Boolean) as string[]);
}

function stringValue(value: string | boolean | undefined, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function numberValue(value: string | boolean | undefined, fallback: number): number {
  if (typeof value !== "string") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function required(value: string | boolean | undefined, name: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new Error(`${name} is required`);
}

function printHelp(): void {
  console.log(`SecFn CLI

Usage:
  secfn scan [--path .] [--staged] [--git-history --commits 100] [--format table|json|sarif] [--fail-on high]
  secfn env pull --endpoint <url> --api-key <key> --set <name> [--output .env]
  secfn env run --endpoint <url> --api-key <key> --set <name> -- <command>
`);
}
