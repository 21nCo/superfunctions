#!/usr/bin/env node
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { approvedDomains, parseApproval, type QualificationApproval } from "./approval.js";
import { liveDrivers } from "./drivers.js";
import { DisposableInventory } from "./inventory.js";
import { LiveHost } from "./live.js";
import { ENDPOINT_INTERFACE, LIVE_MATRIX_TARGET, NETWORKING_QUALIFICATION_CONTRACT } from "./matrix.js";
import { checkPrerequisites, execute, hostProbeEnvironment, localDockerEndpoint } from "./prerequisites.js";
import { networkingOutcomeGate, RECEIPT_CHECK, receiptProblems, redactSecrets, runExitCode, summarize, type NetworkingQualificationReceipt, type Provenance } from "./receipt.js";
import { runScenarios, selectScenarios, type PrerequisiteResult, type RunOptions, type ScenarioResult } from "./runner.js";

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

/**
 * git as found in an absolute PATH directory. Relative entries such as "."
 * are never searched, so the working directory cannot supply the binary.
 */
async function gitCommand(): Promise<string> {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, process.platform === "win32" ? "git.exe" : "git");
    try {
      await access(candidate, constants.X_OK);
      if ((await stat(candidate)).isFile()) return candidate;
    } catch { /* not in this directory */ }
  }
  throw new Error("git was not found in an absolute PATH directory.");
}

const git = async (cwd: string, args: readonly string[]): Promise<string> => {
  const command = await gitCommand();
  return await new Promise((resolve, reject) => {
    execFile(command, [...args], { cwd, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => { if (error) reject(new Error(`git ${args.join(" ")} failed in ${cwd}`)); else resolve(String(stdout)); });
  });
};

/**
 * Build outputs of a checkout older than their source: for every tracked
 * devfn/<package>/src/**.ts, its tsc output devfn/<package>/dist/**.js must
 * exist and be at least as new. Every DevFn package the CLI and harness load
 * is covered, not only their entry points.
 */
export async function staleBuildOutputs(checkout: string): Promise<string[]> {
  const sources = (await git(checkout, ["ls-files", "-z", "--", "devfn"])).split("\0").filter((file) => /^devfn\/(?!docs\/)[^/]+\/src\/.+\.ts$/.test(file) && !file.endsWith(".d.ts"));
  const mtime = async (file: string) => await stat(path.join(checkout, file)).then((item) => item.mtimeMs, () => undefined);
  const stale: string[] = [];
  for (const file of sources) {
    const output = file.replace(/\/src\/(.+)\.ts$/, "/dist/$1.js");
    const [source, built] = [await mtime(file), await mtime(output)];
    if (source === undefined || built === undefined || built < source) stale.push(output);
  }
  return stale;
}

/**
 * Bind a run to the code under test: the harness and the DevFn CLI must come
 * from one clean checkout at --head whose every build output is newer than
 * its source. Anything else is refused before a resource exists.
 */
async function provenance(head: string, devfnCli: string): Promise<Provenance> {
  const harness = fileURLToPath(import.meta.url);
  const checkout = (await git(path.dirname(harness), ["rev-parse", "--show-toplevel"])).trim();
  // The DevFn CLI must lie inside the harness checkout before its directory is used for anything, and that checkout must be its own repository.
  const cli = await realpath(devfnCli).catch(() => { throw new Error(`${devfnCli} does not exist; build the DevFn CLI first.`); });
  if (!cli.startsWith(`${await realpath(checkout)}${path.sep}`)) throw new Error(`${devfnCli} is not inside the harness checkout ${checkout}.`);
  if ((await git(path.dirname(cli), ["rev-parse", "--show-toplevel"])).trim() !== checkout) throw new Error(`${devfnCli} is not built from the harness checkout ${checkout}.`);
  const actual = (await git(checkout, ["rev-parse", "HEAD"])).trim();
  if (actual !== head) throw new Error(`--head ${head} is not the checkout HEAD ${actual}.`);
  if ((await git(checkout, ["status", "--porcelain"])).trim()) throw new Error(`${checkout} has uncommitted or untracked changes; qualify a clean checkout.`);
  const stale = await staleBuildOutputs(checkout);
  if (stale.length) throw new Error(`Build output is missing or older than its source (${stale.slice(0, 5).join(", ")}${stale.length > 5 ? `, ${stale.length - 5} more` : ""}); rebuild before the run.`);
  return { head: actual, checkout, clean: true, builtAfterSources: true, devfnCli };
}

/** Remove the receipt at file, if there is one. Every receipt withdrawal goes through here. */
async function withdrawReceipt(file: string): Promise<void> {
  await rm(file, { force: true });
}

/** Write a receipt atomically with mode 0600: a flushed sibling is renamed over the file, so a reader sees the previous or the new receipt, never a partial one. */
export async function writeReceipt(file: string, receipt: NetworkingQualificationReceipt): Promise<void> {
  const temporary = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx", flush: true });
    await chmod(temporary, 0o600);
    await rename(temporary, file);
  } catch (error) { await rm(temporary, { force: true }).catch(() => undefined); throw error; }
}

export interface QualificationRun {
  options: RunOptions;
  out: string;
  /** Unhandled rejections the process reported so far; read again after every step, since one may arrive at any await. */
  strays: readonly string[];
  /** The receipt for these results and run errors; built again whenever a run error arrives after it was written. */
  receipt(results: ScenarioResult[], runErrors: string[]): NetworkingQualificationReceipt;
  /** Remove leftovers of the run root and its Compose owners; called only after their read-back was recorded. */
  reap(): Promise<void>;
  /** Remove the run root; called only once every resource was read back absent. */
  removeRoot(): Promise<void>;
  write?: (file: string, receipt: NetworkingQualificationReceipt) => Promise<void>;
}

export interface QualificationOutcome { code: number; clean: boolean; receipt?: NetworkingQualificationReceipt; runErrors: string[] }

/** How many times a receipt is rewritten for run errors that keep arriving before it is withdrawn instead. */
const RECEIPT_REWRITES = 5;

/**
 * Run the scenarios, clean up and write the receipt. A failed step, a failed
 * ledger write or an unhandled rejection is a run error, and the remaining
 * cleanup still runs: every recorded resource is removed and read back, and
 * leftovers are reaped, even when an exception leaves this function. After
 * the reap, the root removal and one macrotask turn, the receipt is
 * rewritten whenever a run error arrived since it was written; one that
 * cannot be brought up to date is removed. An interrupted run (code 130)
 * writes no receipt: an interrupt that arrives while the receipt is written
 * or finalized withdraws it. A receipt already at the output path is removed
 * before anything runs, so no failed or interrupted rerun leaves it in place;
 * a run that cannot remove it does not start. The CLI withdraws it earlier
 * still, before its preflight, so this covers direct callers.
 */
export async function executeRun(run: QualificationRun): Promise<QualificationOutcome> {
  const { inventory, resources, signal } = run.options;
  await withdrawReceipt(run.out);
  const failures: string[] = [];
  const runErrors = (): string[] => [...failures, ...inventory.ledgerFailures.map((item) => `inventory ledger: ${item}`), ...run.strays.map((item) => `unhandled rejection during the run: ${item}`)];
  const step = async (name: string, action: () => Promise<unknown>): Promise<void> => {
    try { await action(); } catch (error) { failures.push(`${name} failed: ${message(error)}`); }
  };
  let finished = false;
  /** Leftover processes are reaped only after their read-back was recorded, so a leak stays in the evidence. */
  const finish = async (): Promise<void> => {
    finished = true;
    await step("cleanup", async () => await inventory.cleanup(resources));
    if (!inventory.allAbsent()) await step("reap", run.reap);
  };
  try {
    let results: ScenarioResult[] = [];
    await step("scenario run", async () => { results = await runScenarios(run.options); });
    await step("run-level cleanup", async () => await inventory.cleanup(resources, "run"));
    const clean = inventory.allAbsent();
    if (signal?.aborted) {
      await finish();
      if (inventory.allAbsent()) await step("run root removal", run.removeRoot);
      return { code: 130, clean: inventory.allAbsent(), runErrors: runErrors() };
    }
    const write = run.write ?? writeReceipt;
    let receipt = run.receipt(results, runErrors());
    await write(run.out, receipt);
    // Keep the run root, with its logs and state, whenever anything was not confirmed absent.
    if (!clean) await finish();
    else await step("run root removal", run.removeRoot);
    for (let rewrites = 0; ; rewrites += 1) {
      // A rejection left by any step above is reported within one macrotask turn.
      await new Promise((resolve) => setImmediate(resolve));
      if (runErrors().length === receipt.runErrors.length) break;
      try {
        if (rewrites === RECEIPT_REWRITES) throw new Error(`run errors kept arriving after ${RECEIPT_REWRITES} rewrites`);
        receipt = run.receipt(results, runErrors());
        await write(run.out, receipt);
      } catch (error) {
        await withdrawReceipt(run.out);
        throw new Error(`The receipt ${run.out} was withdrawn: it could not record every run error (${message(error)}).`);
      }
    }
    const errors = runErrors();
    if (signal?.aborted) {
      await withdrawReceipt(run.out);
      return { code: 130, clean, runErrors: errors };
    }
    return { code: runExitCode(receipt, receiptProblems(receipt), clean, errors.length), clean, receipt, runErrors: errors };
  } finally {
    if (!finished && !inventory.allAbsent()) await finish();
  }
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
  if (command === "run") {
    if (!values.head || !/^[a-f0-9]{40}$/.test(values.head) || !values.out) throw new Error("run needs --head <full commit SHA> and --out <receipt file>.");
    // A run attempt withdraws the receipt at --out before anything that can fail or be interrupted, so no failed rerun leaves an earlier receipt there.
    await withdrawReceipt(values.out).catch((error: unknown) => { throw new Error(`The receipt at ${values.out} cannot be withdrawn, so the run does not start: ${message(error)}`); });
  }
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
  const [head, out] = [values.head!, values.out!];
  const source = await provenance(head, devfnCli);
  // Compose runs only against the local engine the prerequisite resolved, pinned for every DevFn and docker command of the run.
  const docker = prerequisites.find((item) => item.id === "docker-compose")?.status === "satisfied" ? await localDockerEndpoint(process.env, execute) : undefined;
  const runId = randomBytes(6).toString("hex");
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), `devfn-qualification-${runId}-`)));
  const ledger = path.join(root, "inventory.json");
  const inventory = new DisposableInventory({ runId, root, domains: approvedDomains(approval), ledger });
  const host = new LiveHost({ root, devfnCli, env: process.env, inventory, docker });
  const handlers = host.handlers();
  process.stderr.write(`Run ${runId}: root ${root}; every resource is recorded in ${ledger} before it is created.\n`);
  // Run-level resources outlive each scenario: the DevFn Caddy the first start launches, and any process left in the run root.
  inventory.record("run-processes", root, "run");
  inventory.record("proxy", host.stateDir, "run");
  // An interrupt stops creation first: in-flight DevFn commands are killed and later ones refused. The one cleanup
  // runs only after the running driver returned, so its read-back sees whatever that driver still created.
  const interrupt = new AbortController();
  const onSignal = (signal: NodeJS.Signals): void => {
    if (interrupt.signal.aborted) { process.stderr.write(`${signal}: exiting without cleanup; ${ledger} lists what may remain.\n`); process.exit(130); }
    process.stderr.write(`${signal}: no receipt is written; stopping the running scenario, then cleaning up the run's resources (${ledger}).\n`);
    interrupt.abort(signal);
    host.abort();
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, onSignal);
  // Drivers join every promise they leave running; should one still reject unhandled, the run records it and fails instead of exiting before cleanup.
  const strays: string[] = [];
  process.on("unhandledRejection", (error: unknown) => { strays.push(message(error)); process.stderr.write(`unhandled rejection during the run: ${message(error)}\n`); });
  const startedAt = new Date().toISOString();
  const secrets = approval ? [approval.oauth?.clientSecretEnv, approval.oauth?.clientIdEnv, approval.cloudflare?.apiTokenEnv, approval.ngrokReserved?.authtokenEnv, approval.ngrokReserved?.apiKeyEnv,
    approval.ngrokEphemeral?.authtokenEnv, approval.ngrokEphemeral?.apiKeyEnv].flatMap((name) => name && process.env[name] ? [process.env[name]!] : []) : [];
  const outcome = await executeRun({ out, strays,
    options: { scenarios, platform: process.platform, prerequisites, drivers: liveDrivers(host, approval), inventory, resources: handlers, snapshot: async () => await host.snapshot(), signal: interrupt.signal },
    receipt: (results, runErrors) => redactSecrets<NetworkingQualificationReceipt>({ contract: NETWORKING_QUALIFICATION_CONTRACT, check: RECEIPT_CHECK, target: LIVE_MATRIX_TARGET, head, runId, provenance: source,
      host: { platform: process.platform, arch: process.arch, release: os.release(), node: process.version }, startedAt, finishedAt: new Date().toISOString(),
      ...(approval ? { approval: { approvedBy: approval.approvedBy, expiresAt: approval.expiresAt } } : {}),
      prerequisites, scenarios: results, runResources: inventory.list("run"), interface: ENDPOINT_INTERFACE, limitations: [...HOST_LIMITATIONS, ...host.limitations], runErrors,
      summary: summarize(results) }, secrets),
    reap: async () => { await host.reap(root, new Set()).catch(() => undefined); await host.reapCompose().catch(() => undefined); },
    removeRoot: async () => await rm(root, { recursive: true, force: true }) });
  const cleanup = outcome.clean ? "confirmed" : `incomplete; inspect ${root}`;
  if (outcome.code === 130) {
    process.stderr.write(`${JSON.stringify({ interrupted: interrupt.signal.reason, cleanup, ledger, runErrors: outcome.runErrors, entries: inventory.list().filter((entry) => !entry.cleanup?.absent).map((entry) => `${entry.kind} ${entry.id}`) })}\n`);
    return 130;
  }
  process.stdout.write(`${JSON.stringify({ receipt: out, summary: outcome.receipt?.summary, problems: outcome.receipt ? receiptProblems(outcome.receipt) : [], cleanup }, null, 2)}\n`);
  // The exit code applies the gate's own receipt check, so a run its producer saw fail never exits 0; a stray after the receipt was final fails it too.
  return outcome.code === 0 && strays.length ? 1 : outcome.code;
}

if (process.argv[1] && await realpath(process.argv[1]).then((file) => file === fileURLToPath(import.meta.url), () => false)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error: unknown) => { process.stderr.write(`${message(error)}\n`); process.exitCode = 2; });
}
