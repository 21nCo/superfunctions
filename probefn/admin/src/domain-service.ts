import path from "node:path";
import {
  SessionManager,
  captureEventDeltaBaseline,
  createCheckpoint,
  diffEventDeltaSummary,
  type CheckpointCaptureSource,
} from "@probefn/core";
import {
  createRunManifest,
  isProbefnError,
  type ProbefnError,
} from "@probefn/contracts";
import { ArtifactStore, redactSensitiveData } from "@probefn/storage";
import {
  AdminError,
  type AdminOperationContext,
} from "@superfunctions/admin";
import type {
  ProbeFnAdminBindingConfig,
  ProbeFnAdminScope,
  ProbeFnAdminService,
  ProbeFnCaptureCheckpointInput,
  ProbeFnDomainAdminServiceOptions,
} from "./types.js";

interface ResolvedBinding {
  repoRoot: string;
  artifactStore: ArtifactStore;
  sessionManager: SessionManager;
  checkpointSource: ProbeFnAdminBindingConfig["checkpointSource"];
}

const safeIdentifierPattern = /^[a-zA-Z0-9._-]+$/;

function requiredSafeIdentifier(value: string, name: string): string {
  if (typeof value !== "string" || !safeIdentifierPattern.test(value)) {
    throw new AdminError("invalid_argument", `${name} must contain only letters, numbers, dot, underscore, or hyphen.`);
  }
  return value;
}

function requiredString(value: string, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AdminError("invalid_argument", `${name} must be a non-empty string.`);
  }
  return value;
}

function scopeKey(scope: ProbeFnAdminScope): string {
  return JSON.stringify([
    scope.installationId,
    scope.workspaceId,
    scope.projectId,
    scope.environmentId,
    scope.namespace ?? "",
    scope.region ?? "",
  ]);
}

function contextScope(context: AdminOperationContext): ProbeFnAdminScope {
  const installationId = context.scope.installationId ?? context.scope.organizationId;
  if (!installationId || !context.scope.workspaceId || !context.scope.projectId || !context.scope.environmentId) {
    throw new AdminError(
      "precondition_failed",
      "ProbeFn administration requires installation, workspace, project, and environment scope.",
    );
  }
  return {
    installationId,
    workspaceId: context.scope.workspaceId,
    projectId: context.scope.projectId,
    environmentId: context.scope.environmentId,
    ...(context.scope.namespace ? { namespace: context.scope.namespace } : {}),
    ...(context.scope.region ? { region: context.scope.region } : {}),
  };
}

function validateConfiguredScope(scope: ProbeFnAdminScope): void {
  requiredString(scope.installationId, "scope.installationId");
  requiredString(scope.workspaceId, "scope.workspaceId");
  requiredString(scope.projectId, "scope.projectId");
  requiredString(scope.environmentId, "scope.environmentId");
  if (scope.namespace !== undefined) requiredString(scope.namespace, "scope.namespace");
  if (scope.region !== undefined) requiredString(scope.region, "scope.region");
}

function translateProbeFnError(error: ProbefnError): AdminError {
  if (error.code === "E_SESSION_NOT_FOUND") {
    return new AdminError("not_found", error.message, { details: error.details, cause: error });
  }
  if (error.code === "E_STORAGE_CAP_EXCEEDED") {
    return new AdminError("rate_limited", error.message, { details: error.details, cause: error });
  }
  if (error.code === "E_CHECKPOINT_CAPTURE_FAILED") {
    return new AdminError("dependency_unavailable", error.message, {
      details: error.details,
      retryable: error.retryable,
      cause: error,
    });
  }
  if (error.code === "E_CONFIG_INVALID") {
    return new AdminError("invalid_argument", error.message, { details: error.details, cause: error });
  }
  return new AdminError("internal", "ProbeFn could not complete the administration operation.", {
    details: { code: error.code, retryable: error.retryable },
    retryable: error.retryable,
    cause: error,
  });
}

async function callProbeFn<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof AdminError) throw error;
    if (isProbefnError(error)) throw translateProbeFnError(error);
    throw new AdminError("internal", "ProbeFn could not complete the administration operation.", { cause: error });
  }
}

function assertTransition(
  current: "starting" | "running" | "completed" | "failed",
  next: "running" | "completed" | "failed",
): void {
  const allowed =
    (next === "running" && (current === "starting" || current === "running")) ||
    (next === "completed" && (current === "running" || current === "completed")) ||
    (next === "failed" && (current === "starting" || current === "running" || current === "failed"));
  if (!allowed) {
    throw new AdminError("conflict", `ProbeFn session cannot transition from ${current} to ${next}.`);
  }
}

function sanitizeArtifactUrl(value: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "about:blank";
    parsed.username = "";
    parsed.password = "";
    parsed.hash = "";
    for (const key of [...parsed.searchParams.keys()]) {
      if (/(authorization|auth|code|cookie|key|password|secret|session|token)/i.test(key)) {
        parsed.searchParams.set(key, "[REDACTED]");
      }
    }
    return redactSensitiveData(parsed.toString()).value;
  } catch {
    return "about:blank";
  }
}

function redactedCheckpointSource(source: CheckpointCaptureSource): CheckpointCaptureSource {
  return {
    url: () => sanitizeArtifactUrl(source.url()),
    viewportSize: () => source.viewportSize(),
    screenshot: () => source.screenshot(),
    domSnapshot: async () => redactSensitiveData(await source.domSnapshot()).value,
    accessibilitySnapshot: async () => redactSensitiveData(await source.accessibilitySnapshot()).value,
    layoutSnapshot: async () => redactSensitiveData(await source.layoutSnapshot()).value,
    ...(source.stylesSnapshot
      ? { stylesSnapshot: async () => redactSensitiveData(await source.stylesSnapshot!()).value }
      : {}),
  };
}

function pathsOverlap(left: string, right: string): boolean {
  const leftToRight = path.relative(left, right);
  const rightToLeft = path.relative(right, left);
  return leftToRight === "" ||
    (!leftToRight.startsWith("..") && !path.isAbsolute(leftToRight)) ||
    (!rightToLeft.startsWith("..") && !path.isAbsolute(rightToLeft));
}

/**
 * Creates an environment-isolated service from static bindings. Every binding
 * owns its ArtifactStore and SessionManager; no filesystem path is accepted
 * from an admin operation.
 */
export function createProbeFnDomainAdminService(
  options: ProbeFnDomainAdminServiceOptions,
): ProbeFnAdminService {
  if (options.bindings.length === 0) {
    throw new AdminError("precondition_failed", "At least one ProbeFn environment binding is required.");
  }

  const bindings = new Map<string, ResolvedBinding>();
  const storageOwners: Array<{ path: string; scope: string }> = [];
  for (const configured of options.bindings) {
    validateConfiguredScope(configured.scope);
    const key = scopeKey(configured.scope);
    if (bindings.has(key)) {
      throw new AdminError("conflict", "Duplicate ProbeFn administration scope binding.");
    }
    requiredString(configured.repoRoot, "repoRoot");
    if (!path.isAbsolute(configured.repoRoot)) {
      throw new AdminError("invalid_argument", "ProbeFn binding repoRoot must be an absolute path.");
    }
    const repoRoot = path.resolve(configured.repoRoot);
    const artifactStore = new ArtifactStore({
      repoRoot,
      ...(configured.artifactRoot ? { artifactRoot: configured.artifactRoot } : {}),
      ...(configured.storageCaps ? { caps: configured.storageCaps } : {}),
    });
    const storageTarget = path.resolve(repoRoot, artifactStore.getArtifactRoot());
    const existingOwner = storageOwners.find((owner) => pathsOverlap(owner.path, storageTarget));
    if (existingOwner) {
      throw new AdminError(
        "conflict",
        "ProbeFn scope bindings may not share the same repository artifact store.",
        { details: { existingScope: existingOwner.scope } },
      );
    }
    storageOwners.push({ path: storageTarget, scope: key });
    bindings.set(key, {
      repoRoot,
      artifactStore,
      sessionManager: new SessionManager({ repoRoot, artifactStore }),
      checkpointSource: configured.checkpointSource,
    });
  }

  function binding(context: AdminOperationContext): ResolvedBinding {
    const activeScope = contextScope(context);
    const found = bindings.get(scopeKey(activeScope));
    if (!found) {
      throw new AdminError("not_found", "ProbeFn is not configured for the exact active environment scope.");
    }
    return found;
  }

  async function readSession(input: { id: string }, context: AdminOperationContext) {
    const current = binding(context);
    const id = requiredSafeIdentifier(input.id, "id");
    return callProbeFn(() => current.sessionManager.read(id));
  }

  async function captureBaseline(input: { sessionId: string }, context: AdminOperationContext) {
    const current = binding(context);
    const sessionId = requiredSafeIdentifier(input.sessionId, "sessionId");
    const session = await callProbeFn(() => current.sessionManager.read(sessionId));
    return callProbeFn(() => captureEventDeltaBaseline(current.repoRoot, session.artifacts));
  }

  return {
    async getSession(input, context) {
      return { item: await readSession(input, context) };
    },

    async initializeSession(input, context) {
      const current = binding(context);
      const sessionId = requiredSafeIdentifier(input.sessionId, "sessionId");
      const runId = requiredSafeIdentifier(input.runId, "runId");
      await callProbeFn(async () => {
        try {
          await current.sessionManager.read(sessionId);
        } catch (error) {
          if (isProbefnError(error) && error.code === "E_SESSION_NOT_FOUND") return;
          throw error;
        }
        throw new AdminError("conflict", `ProbeFn session ${sessionId} already exists in this environment.`);
      });

      const runPaths = current.artifactStore.getRunPaths(runId);
      await callProbeFn(() => current.artifactStore.writeRunManifest(
        runId,
        createRunManifest({
          sessionId,
          runId,
          mode: input.mode,
          browser: input.browser,
          artifactRoot: runPaths.runRoot,
          startedAt: requiredString(input.startedAt, "startedAt"),
          status: "running",
          deterministic: input.deterministic,
        }),
      ));
      const item = await callProbeFn(() => current.sessionManager.initialize({
        sessionId,
        runId,
        mode: input.mode,
        browser: input.browser,
        deterministic: input.deterministic,
        artifactRoot: runPaths.runRoot,
        startedAt: input.startedAt,
        manifestPath: runPaths.sessionManifestPath,
        ...(input.resolvedUrl ? { resolvedUrl: sanitizeArtifactUrl(input.resolvedUrl) } : {}),
        artifacts: {
          tracePath: null,
          consoleSinkPath: path.posix.join(runPaths.eventRoot, "console.ndjson"),
          pageErrorSinkPath: path.posix.join(runPaths.eventRoot, "page-errors.ndjson"),
          networkSinkPath: path.posix.join(runPaths.eventRoot, "network.ndjson"),
        },
      }));
      return { item };
    },

    async markSessionRunning(input, context) {
      const current = binding(context);
      const id = requiredSafeIdentifier(input.id, "id");
      const session = await callProbeFn(() => current.sessionManager.read(id));
      assertTransition(session.status, "running");
      const item = await callProbeFn(() => current.sessionManager.markRunning(id, {
        ...(input.resolvedUrl ? { resolvedUrl: sanitizeArtifactUrl(input.resolvedUrl) } : {}),
      }));
      return { item };
    },

    async markSessionCompleted(input, context) {
      const current = binding(context);
      const id = requiredSafeIdentifier(input.id, "id");
      const session = await callProbeFn(() => current.sessionManager.read(id));
      assertTransition(session.status, "completed");
      return { item: await callProbeFn(() => current.sessionManager.markCompleted(id)) };
    },

    async markSessionFailed(input, context) {
      const current = binding(context);
      const id = requiredSafeIdentifier(input.id, "id");
      const session = await callProbeFn(() => current.sessionManager.read(id));
      assertTransition(session.status, "failed");
      return { item: await callProbeFn(() => current.sessionManager.markFailed(id)) };
    },

    async captureDeltaBaseline(input, context) {
      return {
        sessionId: requiredSafeIdentifier(input.sessionId, "sessionId"),
        baseline: await captureBaseline(input, context),
      };
    },

    async diffEventDelta(input) {
      return { delta: diffEventDeltaSummary(input.before, input.after) };
    },

    async captureCheckpoint(input: ProbeFnCaptureCheckpointInput, context) {
      const current = binding(context);
      const sessionId = requiredSafeIdentifier(input.sessionId, "sessionId");
      const name = requiredSafeIdentifier(input.name, "name");
      const session = await callProbeFn(() => current.sessionManager.read(sessionId));
      if (session.status !== "running") {
        throw new AdminError("conflict", "ProbeFn checkpoints can only be captured for a running session.");
      }
      const after = await captureBaseline({ sessionId }, context);
      const source = redactedCheckpointSource(await callProbeFn(async () =>
        current.checkpointSource({ input, session, context }),
      ));
      const item = await callProbeFn(() => createCheckpoint({
        repoRoot: current.repoRoot,
        artifactStore: current.artifactStore,
        sessionId,
        runId: session.runId,
        browser: session.browser,
        name,
        source,
        delta: diffEventDeltaSummary(input.before, after),
        ...(input.includeStyles !== undefined ? { includeStyles: input.includeStyles } : {}),
        ...(input.includeTrace !== undefined ? { includeTrace: input.includeTrace } : {}),
        ...(input.unstable !== undefined ? { unstable: input.unstable } : {}),
        ...(session.artifacts.tracePath !== undefined ? { tracePath: session.artifacts.tracePath } : {}),
      }));
      return { accepted: true, item };
    },

    async exportReport(input, context) {
      const current = binding(context);
      const sessionId = requiredSafeIdentifier(input.sessionId, "sessionId");
      const exported = await callProbeFn(() => current.sessionManager.exportReport({
        sessionId,
        format: input.format,
      }));
      return {
        accepted: true,
        sessionId,
        format: input.format,
        reportPath: exported.reportPath,
        tracePath: exported.tracePath,
        redactedValueCount: exported.redactedValueCount,
        warnings: exported.warnings,
        includes: exported.includes,
      };
    },

    async getRunPaths(input, context) {
      const current = binding(context);
      return { item: current.artifactStore.getRunPaths(requiredSafeIdentifier(input.runId, "runId")) };
    },

    async getCheckpointPaths(input, context) {
      const current = binding(context);
      return {
        item: current.artifactStore.getCheckpointPaths(
          requiredSafeIdentifier(input.runId, "runId"),
          requiredSafeIdentifier(input.name, "name"),
        ),
      };
    },
  };
}
