import {
  AnalyticsEngine,
  type TestResult,
  type TestResults,
  type TestRun,
  type TestStorage,
} from "@testfn/core";
import { AdminError, type AdminOperationContext } from "@superfunctions/admin";
import type {
  TestFnAdminRun,
  TestFnAdminService,
  TestFnDomainAdminBinding,
  TestFnDomainAdminServiceOptions,
} from "./types.js";

const claimedScopes = new WeakMap<object, string>();
const storageQueues = new WeakMap<TestStorage, Promise<unknown>>();

function scopeKey(context: AdminOperationContext): string {
  const { installationId, organizationId, workspaceId, projectId, environmentId, namespace, region } = context.scope;
  if (!projectId) {
    throw new AdminError("invalid_argument", "TestFn administration requires a project scope.");
  }
  return JSON.stringify([
    installationId ?? organizationId ?? "",
    workspaceId ?? "",
    projectId,
    environmentId ?? "",
    namespace ?? "",
    region ?? "",
  ]);
}

function claim(binding: TestFnDomainAdminBinding, key: string): void {
  for (const domainObject of [binding.runner, binding.storage, binding.visual]) {
    const claimed = claimedScopes.get(domainObject);
    if (claimed && claimed !== key) {
      throw new AdminError(
        "precondition_failed",
        "A TestFn admin binding cannot be reused across administration scopes.",
      );
    }
    claimedScopes.set(domainObject, key);
  }
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new AdminError("invalid_argument", `${name} must be a non-empty string.`);
  }
  return value;
}

function integer(
  value: unknown,
  name: string,
  fallback: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new AdminError("invalid_argument", `${name} must be an integer between 1 and ${maximum}.`);
  }
  return value as number;
}

function screenshot(value: unknown): Buffer {
  const encoded = requiredString(value, "screenshotBase64");
  if (encoded.length > 28_000_000) {
    throw new AdminError("invalid_argument", "screenshotBase64 exceeds the 28 MB encoded limit.");
  }
  const decoded = Buffer.from(encoded, "base64");
  const canonicalInput = encoded.replace(/=+$/u, "");
  const canonicalOutput = decoded.toString("base64").replace(/=+$/u, "");
  if (decoded.length === 0 || canonicalInput !== canonicalOutput) {
    throw new AdminError("invalid_argument", "screenshotBase64 must contain canonical base64 image bytes.");
  }
  return decoded;
}

function visualId(value: unknown): string {
  const id = requiredString(value, "id");
  if (id.length > 255 || !/^[A-Za-z0-9._-]+$/u.test(id)) {
    throw new AdminError("invalid_argument", "Visual target id must be a safe file identifier.");
  }
  return id;
}

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function mapResult(result: TestResult) {
  return {
    id: result.id,
    status: result.status,
    duration: result.duration,
    hasError: Boolean(result.error),
    artifactTypes: (result.artifacts ?? []).map((artifact) => artifact.type),
  };
}

function mapRun(run: TestRun): TestFnAdminRun {
  return {
    id: run.id,
    timestamp: run.timestamp,
    summary: run.summary,
    results: run.results.map(mapResult),
    environment: run.environment,
    ...(run.branch ? { branch: run.branch } : {}),
    ...(run.commit ? { commit: run.commit } : {}),
  };
}

function persistedRun(results: TestResults, binding: TestFnDomainAdminBinding): TestRun {
  return {
    id: results.id,
    timestamp: results.timestamp,
    summary: results.summary,
    results: results.results,
    environment: binding.environment,
  };
}

async function withStorage<T>(storage: TestStorage, operation: () => Promise<T>): Promise<T> {
  const previous = storageQueues.get(storage)?.catch(() => undefined) ?? Promise.resolve();
  const current = previous.then(async () => {
    await storage.open();
    try {
      return await operation();
    } finally {
      await storage.close();
    }
  });
  storageQueues.set(storage, current);
  try {
    return await current;
  } finally {
    if (storageQueues.get(storage) === current) storageQueues.delete(storage);
  }
}

/** Uses TestFn public runner, storage, analytics, and visual APIs without raw persistence access. */
export function createTestFnDomainAdminService(
  options: TestFnDomainAdminServiceOptions,
): TestFnAdminService {
  async function binding(context: AdminOperationContext): Promise<TestFnDomainAdminBinding> {
    const key = scopeKey(context);
    const resolved = await options.resolve(context);
    if (!resolved?.runner || !resolved.storage || !resolved.visual || !resolved.environment) {
      throw new AdminError("dependency_unavailable", "The active scope has no complete TestFn admin binding.");
    }
    claim(resolved, key);
    return resolved;
  }

  return {
    async listRuns(input, context) {
      const resolved = await binding(context);
      const limit = integer(input.limit, "limit", 50, 200);
      const runs = await withStorage(resolved.storage, () => resolved.storage.getRecentRuns(limit));
      return { items: runs.map(mapRun), nextCursor: null };
    },

    async getRun(input, context) {
      const resolved = await binding(context);
      const run = await withStorage(resolved.storage, () => resolved.storage.getRun(requiredString(input.id, "id")));
      if (!run) throw new AdminError("not_found", "The TestFn run was not found in the active scope.");
      return { item: mapRun(run) };
    },

    async startRun(_input, context) {
      const resolved = await binding(context);
      const results = await resolved.runner.run();
      const run = persistedRun(results, resolved);
      await withStorage(resolved.storage, () => resolved.storage.saveRun(run));
      return { item: mapRun(run) };
    },

    async cleanupRuns(input, context) {
      if (input.id !== "expired") {
        throw new AdminError("invalid_argument", "Cleanup target id must be expired.");
      }
      requiredString(input.reason, "reason");
      const resolved = await binding(context);
      await withStorage(resolved.storage, () => resolved.storage.cleanup());
      return { accepted: true };
    },

    async getArtifact(input, context) {
      const resolved = await binding(context);
      const id = requiredString(input.id, "id");
      const artifact = await withStorage(resolved.storage, () => resolved.storage.getArtifact(id));
      if (!artifact) throw new AdminError("not_found", "The TestFn artifact was not found in the active scope.");
      return { item: { id, type: artifact.type, available: true } };
    },

    async getMetrics(input, context) {
      const resolved = await binding(context);
      const id = requiredString(input.id, "id");
      const metrics = await withStorage(resolved.storage, () => new AnalyticsEngine(resolved.storage).computeMetrics(id));
      return {
        item: {
          id,
          ...metrics,
          successRate: finite(metrics.successRate),
          avgDuration: finite(metrics.avgDuration),
          p50Duration: finite(metrics.p50Duration),
          p95Duration: finite(metrics.p95Duration),
          p99Duration: finite(metrics.p99Duration),
        },
      };
    },

    async getFlakiness(input, context) {
      const resolved = await binding(context);
      const id = requiredString(input.id, "id");
      const analysis = await withStorage(resolved.storage, () =>
        new AnalyticsEngine(resolved.storage).detectFlaky(id, integer(input.windowSize, "windowSize", 10, 100)),
      );
      return { item: { id, ...analysis } };
    },

    async getTrends(input, context) {
      const resolved = await binding(context);
      const id = requiredString(input.id, "id");
      const trends = await withStorage(resolved.storage, () =>
        new AnalyticsEngine(resolved.storage).getTrends(id, integer(input.days, "days", 30, 365)),
      );
      return { item: { id, ...trends } };
    },

    async getRegressions(input, context) {
      const resolved = await binding(context);
      const baselineRunId = requiredString(input.baselineRunId, "baselineRunId");
      const currentRunId = requiredString(input.currentRunId, "currentRunId");
      const items = await withStorage(resolved.storage, () =>
        new AnalyticsEngine(resolved.storage).findRegressions(baselineRunId, currentRunId),
      );
      return {
        items: items.map((regression) => ({
          ...regression,
          baseline: finite(regression.baseline),
          current: finite(regression.current),
          change: finite(regression.change),
        })),
      };
    },

    async getVisualDiff(input, context) {
      const resolved = await binding(context);
      const id = visualId(input.id);
      const diff = await resolved.visual.getDiff(id);
      return { item: { id, available: diff !== null, sizeBytes: diff?.byteLength ?? 0 } };
    },

    async compareScreenshot(input, context) {
      const resolved = await binding(context);
      const id = visualId(input.id);
      const captured = await resolved.visual.captureScreenshot(id, screenshot(input.screenshotBase64));
      const { diffImage: _diffImage, ...comparison } = await resolved.visual.compareScreenshot(captured, id);
      return { item: { id, ...comparison } };
    },

    async updateBaseline(input, context) {
      requiredString(input.reason, "reason");
      const resolved = await binding(context);
      const id = visualId(input.id);
      const captured = await resolved.visual.captureScreenshot(id, screenshot(input.screenshotBase64));
      await resolved.visual.updateBaseline(id, captured);
      return { accepted: true };
    },
  };
}
