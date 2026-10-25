#!/usr/bin/env node
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { approvedDomains, parseApproval, type QualificationApproval } from "./approval.js";
import { liveDrivers } from "./drivers.js";
import { DisposableInventory } from "./inventory.js";
import { LiveHost } from "./live.js";
import { ENDPOINT_INTERFACE, LIVE_MATRIX_TARGET, NETWORKING_QUALIFICATION_CONTRACT } from "./matrix.js";
import { checkPrerequisites, hostProbeEnvironment } from "./prerequisites.js";
import { networkingOutcomeGate, RECEIPT_CHECK, receiptProblems, redactSecrets, summarize, type NetworkingQualificationReceipt, type Provenance } from "./receipt.js";
import { runScenarios, selectScenarios, type PrerequisiteResult } from "./runner.js";

const USAGE = `Usage: devfn-networking-qualification <plan|run|gate> [options]

  plan   Check prerequisites and list which selected scenarios could run here. Creates nothing.
  run    Execute the selected live scenarios and write a receipt; exits 0 only if every one passed.
  gate   Check receipts for the DEV-2 networking outcome at --head on macOS and Linux.

Options:
  --scenario <id>        Select a scenario (repeatable); default all
  --row <n>              Select a deferred matrix row (repeatable)
  --approval <file>      Operator approval of nonproduction resources (JSON; names credential variables, never values)
  --browser-operator     A person or browser agent will complete provider sign-ins during the run
  --devfn <file>         Built DevFn CLI entry (default: this checkout's devfn/cli/dist/index.js)
  --head <sha>           Exact commit under test: run needs it to be this clean, built checkout's HEAD (run, gate)
  --out <file>           Receipt path (run)
`;

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

async function loadApproval(file: string | undefined): Promise<{ approval?: QualificationApproval; approvalError?: string }> {
  if (!file) return {};
  try { return { approval: parseApproval(JSON.parse(await readFile(file, "utf8"))) }; } catch (error) { return { approvalError: `approval refused: ${message(error)}` }; }
}

/** Limitations every receipt records; the provider gaps of each binding the run registered are added as it registers them. */
const HOST_LIMITATIONS = ["Windows is not qualified; no Windows support is claimed without Windows evidence.",
  "Linux proxy listeners use ports 80 and 443; the operator must permit Caddy to bind them before the run.",
  "Internal TLS is verified against the DevFn Caddy root by the harness only; browsers need an explicit, operator-chosen trust decision."];

const git = async (cwd: string, args: readonly string[]): Promise<string> => await new Promise((resolve, reject) => {
  execFile("git", [...args], { cwd, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => { if (error) reject(new Error(`git ${args.join(" ")} failed in ${cwd}`)); else resolve(String(stdout)); });
});

/**
 * Bind a run to the code under test: the harness and the DevFn CLI must come
 * from one clean checkout at --head, built after its sources were last
 * written. Anything else is refused before a resource exists.
 */
async function provenance(head: string, devfnCli: string): Promise<Provenance> {
  const harness = fileURLToPath(import.meta.url);
  const checkout = (await git(path.dirname(harness), ["rev-parse", "--show-toplevel"])).trim();
  if ((await git(path.dirname(devfnCli), ["rev-parse", "--show-toplevel"])).trim() !== checkout) throw new Error(`${devfnCli} is not built from the harness checkout ${checkout}.`);
  const actual = (await git(checkout, ["rev-parse", "HEAD"])).trim();
  if (actual !== head) throw new Error(`--head ${head} is not the checkout HEAD ${actual}.`);
  if ((await git(checkout, ["status", "--porcelain"])).trim()) throw new Error(`${checkout} has uncommitted or untracked changes; qualify a clean checkout.`);
  const sources = (await git(checkout, ["ls-files", "-z", "--", "devfn"])).split("\0").filter((file) => /^devfn\/[^/]+\/src\//.test(file));
  const newest = Math.max(...await Promise.all(sources.map(async (file) => (await stat(path.join(checkout, file))).mtimeMs)));
  const built = Math.min(...await Promise.all([devfnCli, harness].map(async (file) => (await stat(file)).mtimeMs)));
  if (built < newest) throw new Error("The built DevFn CLI or harness is older than the checkout sources; rebuild before the run.");
  return { head: actual, checkout, clean: true, builtAfterSources: true, devfnCli };
}

export async function main(argv: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args: [...argv], allowPositionals: true, options: {
    scenario: { type: "string", multiple: true }, row: { type: "string", multiple: true }, approval: { type: "string" }, "browser-operator": { type: "boolean" },
    devfn: { type: "string" }, head: { type: "string" }, out: { type: "string" }, help: { type: "boolean" } } });
  const [command, ...files] = positionals;
  if (values.help || !command) { process.stdout.write(USAGE); return command ? 0 : 2; }
  if (command === "gate") {
    if (!values.head || !files.length) throw new Error("gate needs --head and at least one receipt file.");
    const receipts = await Promise.all(files.map(async (file) => JSON.parse(await readFile(file, "utf8")) as NetworkingQualificationReceipt));
    const gate = networkingOutcomeGate(receipts, values.head);
    process.stdout.write(`${JSON.stringify({ ...gate, problems: Object.fromEntries(files.map((file, index) => [file, receiptProblems(receipts[index])])) }, null, 2)}\n`);
    return gate.ready ? 0 : 1;
  }
  if (command !== "plan" && command !== "run") throw new Error(`Unknown command ${command}.\n${USAGE}`);
  const scenarios = selectScenarios({ scenarios: values.scenario, rows: values.row?.map(Number) });
  const devfnCli = path.resolve(values.devfn ?? fileURLToPath(new URL("../../../cli/dist/index.js", import.meta.url)));
  const { approval, approvalError } = await loadApproval(values.approval);
  const prerequisites: PrerequisiteResult[] = await checkPrerequisites(hostProbeEnvironment({ devfnCli, approval, approvalError, browserOperator: values["browser-operator"] === true }),
    scenarios.flatMap((scenario) => scenario.prerequisites));
  if (command === "plan") {
    const unmet = (ids: readonly string[]) => ids.filter((id) => prerequisites.find((item) => item.id === id)?.status !== "satisfied");
    process.stdout.write(`${JSON.stringify({ contract: NETWORKING_QUALIFICATION_CONTRACT, target: LIVE_MATRIX_TARGET, platform: process.platform, prerequisites,
      scenarios: scenarios.map((scenario) => ({ id: scenario.id, row: scenario.row, title: scenario.title, runnable: unmet(scenario.prerequisites).length === 0,
        unmet: unmet(scenario.prerequisites), assertions: scenario.assertions.map((item) => item.id), fixtureEvidence: scenario.fixtureEvidence })) }, null, 2)}\n`);
    return 0;
  }
  if (!values.head || !/^[a-f0-9]{40}$/.test(values.head) || !values.out) throw new Error("run needs --head <full commit SHA> and --out <receipt file>.");
  const source = await provenance(values.head, devfnCli);
  const runId = randomBytes(6).toString("hex");
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), `devfn-qualification-${runId}-`)));
  const ledger = path.join(root, "inventory.json");
  const inventory = new DisposableInventory({ runId, root, domains: approvedDomains(approval), ledger });
  const host = new LiveHost({ root, devfnCli, env: process.env, inventory });
  const handlers = host.handlers();
  process.stderr.write(`Run ${runId}: root ${root}; every resource is recorded in ${ledger} before it is created.\n`);
  // Run-level resources outlive each scenario: the DevFn Caddy the first start launches, and any process left in the run root.
  inventory.record("run-processes", root, "run");
  inventory.record("proxy", host.stateDir, "run");
  /** Leftover processes are reaped only after their read-back was recorded, so a leak stays in the evidence. */
  const finish = async (): Promise<void> => {
    await inventory.cleanup(handlers);
    if (!inventory.allAbsent()) await host.reap(root, new Set()).catch(() => undefined);
  };
  let interrupted = false;
  const onSignal = (signal: NodeJS.Signals): void => {
    if (interrupted) { process.stderr.write(`${signal}: exiting without cleanup; ${ledger} lists what may remain.\n`); process.exit(130); }
    interrupted = true;
    process.stderr.write(`${signal}: no receipt is written; cleaning up the run's resources (${ledger}).\n`);
    void finish().then(() => inventory.allAbsent(), () => false).then((clean) => {
      process.stderr.write(`${JSON.stringify({ interrupted: signal, cleanup: clean ? "confirmed" : "incomplete", ledger, entries: inventory.list().filter((entry) => !entry.cleanup?.absent).map((entry) => `${entry.kind} ${entry.id}`) })}\n`);
      process.exit(130);
    });
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, onSignal);
  const startedAt = new Date().toISOString();
  const results = await runScenarios({ scenarios, platform: process.platform, prerequisites, drivers: liveDrivers(host, approval), inventory, resources: handlers, snapshot: async () => await host.snapshot() });
  await inventory.cleanup(handlers, "run");
  const secrets = approval ? [approval.oauth?.clientSecretEnv, approval.oauth?.clientIdEnv, approval.cloudflare?.apiTokenEnv, approval.ngrokReserved?.authtokenEnv, approval.ngrokReserved?.apiKeyEnv,
    approval.ngrokEphemeral?.authtokenEnv, approval.ngrokEphemeral?.apiKeyEnv].flatMap((name) => name && process.env[name] ? [process.env[name]!] : []) : [];
  const receipt: NetworkingQualificationReceipt = redactSecrets({ contract: NETWORKING_QUALIFICATION_CONTRACT, check: RECEIPT_CHECK, target: LIVE_MATRIX_TARGET, head: values.head, runId, provenance: source,
    host: { platform: process.platform, arch: process.arch, release: os.release(), node: process.version }, startedAt, finishedAt: new Date().toISOString(),
    ...(approval ? { approval: { approvedBy: approval.approvedBy, expiresAt: approval.expiresAt } } : {}),
    prerequisites, scenarios: results, runResources: inventory.list("run"), interface: ENDPOINT_INTERFACE, limitations: [...HOST_LIMITATIONS, ...host.limitations],
    summary: summarize(results) }, secrets);
  await writeFile(values.out, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  const clean = inventory.allAbsent();
  if (!clean) await finish();
  // Keep the run root, with its logs and state, whenever anything was not confirmed absent.
  if (clean) await rm(root, { recursive: true, force: true });
  process.stdout.write(`${JSON.stringify({ receipt: values.out, summary: receipt.summary, problems: receiptProblems(receipt), cleanup: clean ? "confirmed" : `incomplete; inspect ${root}` }, null, 2)}\n`);
  return receipt.summary.passed === results.length && clean ? 0 : 1;
}

if (process.argv[1] && await realpath(process.argv[1]).then((file) => file === fileURLToPath(import.meta.url), () => false)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error: unknown) => { process.stderr.write(`${message(error)}\n`); process.exitCode = 2; });
}
