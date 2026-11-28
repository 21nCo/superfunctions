#!/usr/bin/env node
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { tmpdir } from "node:os";

import { safeRead, FileArtifactStore, ReviewCoordinator, ReviewFnError, renderMarkdownReport, type ReviewFnConfig, type ReviewReport } from "@superfunctions/reviewfn-core";
import { githubRepositoryIdentity, GitHubAdvisoryPublisher, GitHubApi, GitSourceControlAdapter } from "@superfunctions/reviewfn-github";
import { CodexHarnessAdapter } from "@superfunctions/reviewfn-harness-codex";
import { evaluate, type EvaluationCase, type EvaluationOutcome } from "@superfunctions/reviewfn-testing";

import { initializeConfiguration, initializePanelPolicy } from "./config.js";
import { expectedCliMismatch } from "./expected-cli.js";
import { LocalIsolatedExecutionAdapter } from "./execution.js";
import { contextAdapters, createReviewSnapshot, loadRunConfiguration, optional, parseArguments, publication, renderStoredReport, required, runPanelCommand } from "./panel.js";

async function createCoordinator(root: string, config: ReviewFnConfig, pullRequest?: number, targetBranch?: string) {
  if (process.env.GITHUB_TOKEN) throw new Error("Review execution must not receive GITHUB_TOKEN; use the separate publish command in a credentialed job.");
  const sourceControl = new GitSourceControlAdapter({ targetBranch });
  const artifacts = new FileArtifactStore(path.resolve(root, "../artifacts"));
  return new ReviewCoordinator({
    sourceControl,
    contexts: contextAdapters(config),
    harness: new CodexHarnessAdapter({ executable: config.harness.executable }),
    execution: new LocalIsolatedExecutionAdapter(artifacts),
    artifacts,
    publishers: [],
  });
}

async function run(): Promise<number> {
  const args = parseArguments(process.argv.slice(2));
  const root = path.resolve(optional(args.flags, "root") ?? process.cwd());
  if (args.command === "--version") { process.stdout.write(`${(createRequire(import.meta.url)("../package.json") as { version: string }).version}\n`); return 0; }
  if (!args.command || args.command === "help" || args.flags.has("help")) { process.stdout.write(help()); return 0; }
  if (args.command === "init") {
    if (typeof args.flags.get("panel") === "string") throw new Error("--panel takes no value.");
    const files = args.flags.has("panel") ? [await initializePanelPolicy(root)] : await initializeConfiguration(root);
    process.stdout.write(`${files.map((file) => path.relative(root, file)).join("\n")}\n`);
    return 0;
  }
  if (args.command === "render") {
    const input = path.resolve(root, required(args.flags, "input"));
    process.stdout.write(renderMarkdownReport(JSON.parse(await readFile(input, "utf8")) as ReviewReport));
    return 0;
  }
  if (args.command === "report") {
    process.stdout.write(await renderStoredReport(args.flags, root));
    return 0;
  }
  if (args.command === "panel") {
    const controller = new AbortController();
    const abort = () => controller.abort();
    process.once("SIGINT", abort);
    process.once("SIGTERM", abort);
    try { return await runPanelCommand(args.flags, { signal: controller.signal }); }
    finally {
      process.removeListener("SIGINT", abort);
      process.removeListener("SIGTERM", abort);
    }
  }
  if (args.command === "publish") {
    const value: unknown = JSON.parse((await safeRead(path.resolve(root, required(args.flags, "input")))).toString("utf8"));
    const repository = required(args.flags, "repository").split("/");
    const pullRequest = Number(required(args.flags, "pull-request"));
    const expectedHead = required(args.flags, "head");
    if (repository.length !== 2 || !process.env.GITHUB_TOKEN || !Number.isInteger(pullRequest) || pullRequest <= 0) throw new Error("Publication requires repository, PR number and GITHUB_TOKEN.");
    const { report, rendered, profile } = publication(value, args.flags);
    if (report.change.headCommit !== expectedHead || report.change.pullRequest !== pullRequest) throw new Error("Artifact does not match trusted publication identity or is not completed.");
    if (githubRepositoryIdentity(report.change.repositoryId) !== repository.join("/").toLowerCase()) throw new Error("Artifact repository does not match the trusted publication target.");
    const publisher = new GitHubAdvisoryPublisher({ api: new GitHubApi({ owner: repository[0], repository: repository[1], token: process.env.GITHUB_TOKEN }), pullRequest, publisherLogin: optional(args.flags, "publisher-login") });
    const result = await publisher.publish({ report, rendered, expectedHead, profile });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result.status === "failed" || result.status === "stale" ? 1 : 0;
  }
  if (args.command === "evaluate") {
    const input = JSON.parse(await readFile(path.resolve(root, required(args.flags, "input")), "utf8")) as { cases: EvaluationCase[]; outcomes: EvaluationOutcome[] };
    process.stdout.write(`${JSON.stringify(evaluate(input.cases, input.outcomes), null, 2)}\n`);
    return 0;
  }
  if (!["preflight", "review"].includes(args.command)) throw new Error(`Unknown command ${args.command}.`);
  const base = required(args.flags, "base");
  const head = required(args.flags, "head");
  const pullRequestText = optional(args.flags, "pull-request") ?? process.env.GITHUB_EVENT_PULL_REQUEST_NUMBER;
  const pullRequest = pullRequestText === undefined ? undefined : Number(pullRequestText);
  if (pullRequestText !== undefined && (!Number.isInteger(pullRequest) || pullRequest! <= 0)) throw new Error("--pull-request must be a positive integer.");
  const { config, policy } = await loadRunConfiguration(root, base, args.flags);
  const owned = await mkdtemp(path.join(tmpdir(), "reviewfn-run-"));
  try {
  const snapshot = await createReviewSnapshot(root, owned, base, head, optional(args.flags, "target-branch"));
  const coordinator = await createCoordinator(snapshot.root, config, pullRequest, snapshot.targetBranch);
  const request = { root: snapshot.root, base: snapshot.base, head: snapshot.head, pullRequest, config, policy, issue: optional(args.flags, "issue") };
  if (args.command === "preflight") {
    const diagnostics = await coordinator.preflight(request);
    process.stdout.write(`${JSON.stringify({ ok: !diagnostics.some((item) => item.level === "error"), diagnostics }, null, 2)}\n`);
    return diagnostics.some((item) => item.level === "error") ? 1 : 0;
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    const result = await coordinator.run({ ...request, signal: controller.signal });
    const outputDirectory = path.resolve(root, optional(args.flags, "output") ?? ".reviewfn/output");
    const store = new FileArtifactStore(path.join(outputDirectory, "artifacts"), outputDirectory);
    // Merge retained artifacts without shortening expiration for prior references.
    await store.importFrom(path.join(owned, "artifacts"));
    const cleanup = await store.deleteExpired();
    await store.writeReportCopies(`${JSON.stringify(result.report, null, 2)}\n`, result.rendered, Math.min(config.retention.reportDays, policy.retention.reportDays));
    process.stdout.write(`${result.rendered}\n`);
    if (cleanup.errors.length) {
      process.stderr.write(`${JSON.stringify({ error: "REVIEWFN_RETENTION_CLEANUP_FAILED", message: "Review outputs were saved, but retention cleanup failed; inspect the output store and retry cleanup.", details: cleanup.errors })}\n`);
      return 1;
    }
    return result.report.execution === "completed" ? 0 : 1;
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
  } finally { await rm(owned, { recursive: true, force: true }); }
}

function help(): string {
  return `ReviewFn — evidence-backed pull request review\n\nUsage:\n  reviewfn --version\n  reviewfn init [--root PATH] [--panel]\n  reviewfn preflight --base REF --head REF [--issue ID] [--trusted-config-from-base]\n  reviewfn review --base REF --head REF [--pull-request N] [--issue ID] [--output DIR]\n  reviewfn publish --input report.json --repository OWNER/REPO --pull-request N --head SHA --profile NAME\n  reviewfn panel --base REF --head REF [--since SHA] [--issue ID] [--pull-request N] [--panel FILE] [--output DIR] [--trusted-config-from-base] [--json]\n  reviewfn report [--panel] [--input FILE]\n  reviewfn publish --input panel-report.json --repository OWNER/REPO --pull-request N --head SHA [--profile panel]\n  reviewfn render --input report.json\n  reviewfn evaluate --input evaluation.json\n\nReview is advisory by default. Configuration and policy are loaded from .reviewfn/, and the panel policy from .reviewfn/panel.json.\nreviewfn panel exits 0 (complete), 2 (incomplete coverage or quorum not met), 3 (preflight failed), 4 (canceled) or 1 (other error).\n`;
}

const mismatch = expectedCliMismatch(createRequire(import.meta.url)("../package.json") as { name: string; version: string });
if (mismatch) {
  process.stderr.write(`reviewfn: ${mismatch}\n`);
  process.exitCode = 1;
} else {
  run().then((code) => { process.exitCode = code; }).catch((error) => {
    const payload = error instanceof ReviewFnError ? { error: error.code, message: error.message, details: error.details } : { error: "REVIEWFN_UNEXPECTED", message: error instanceof Error ? error.message : String(error) };
    process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
    process.exitCode = 1;
  });
}
