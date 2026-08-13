import {
  AdminError,
  type AdminOperationContext,
} from "@superfunctions/admin";
import type {
  CiFnAdminService,
  CiFnArtifactView,
  CiFnDownloadArtifactInput,
  CiFnDownloadArtifactOutput,
  CiFnGetJobInput,
  CiFnGetJobOutput,
  CiFnGetRunInput,
  CiFnGetRunOutput,
  CiFnJobView,
  CiFnListArtifactsInput,
  CiFnListArtifactsOutput,
  CiFnRetryRunOutput,
  CiFnRunMutationOutput,
  CiFnRunView,
  CiFnTriggerRunInput,
  CiFnTriggerRunOutput,
} from "./types.js";

export interface CiFnControlPlaneConnection {
  /** Base URL of the isolated control plane selected for this admin scope. */
  baseUrl: string;
  apiKey?: string;
  headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
  fetch?: typeof fetch;
}

export interface CiFnControlPlaneAdminServiceOptions {
  /**
   * Static single-installation connection. Use `resolveConnection` when one
   * Super Console serves more than one scope.
   */
  connection?: CiFnControlPlaneConnection;
  /** Resolves the authorized context to its tenant-isolated control plane. */
  resolveConnection?: (
    context: AdminOperationContext,
  ) => CiFnControlPlaneConnection | Promise<CiFnControlPlaneConnection>;
}

interface ControlPlaneErrorEnvelope {
  ok: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
    retryable?: boolean;
  };
}

interface ControlPlaneSuccessEnvelope<T> {
  ok: true;
  data: T;
}

function trimBaseUrl(value: string): string {
  const normalized = value.trim().replace(/\/+$/, "");
  if (!normalized) throw new Error("CiFn control-plane baseUrl is required.");
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isControlPlaneError(value: unknown): value is ControlPlaneErrorEnvelope {
  return isRecord(value)
    && value.ok === false
    && isRecord(value.error)
    && typeof value.error.code === "string"
    && typeof value.error.message === "string";
}

function adminErrorForControlPlane(
  response: Response,
  payload: unknown,
): AdminError {
  if (isControlPlaneError(payload)) {
    const code = payload.error.code;
    const options = {
      status: response.status,
      details: payload.error.details,
      retryable: payload.error.retryable,
    };
    if (code === "RUN_NOT_FOUND" || code === "RUNNER_NOT_FOUND") {
      return new AdminError("not_found", payload.error.message, options);
    }
    if (code === "RUN_ALREADY_FINISHED") {
      return new AdminError("conflict", payload.error.message, options);
    }
    if (code === "BAD_REQUEST" || code === "PIPELINE_INVALID") {
      return new AdminError("invalid_argument", payload.error.message, options);
    }
    if (code === "RUN_CREATE_FAILED") {
      return new AdminError("precondition_failed", payload.error.message, options);
    }
    if (code === "UNAUTHORIZED") {
      return new AdminError(
        "dependency_unavailable",
        "The CiFn control-plane connection rejected its service credential.",
        { ...options, retryable: false },
      );
    }
    return new AdminError(
      response.status >= 500 ? "dependency_unavailable" : "internal",
      payload.error.message,
      options,
    );
  }
  return new AdminError(
    response.status >= 500 ? "dependency_unavailable" : "internal",
    `CiFn control plane returned HTTP ${response.status}.`,
    { status: response.status, retryable: response.status >= 500 },
  );
}

function assertRun(value: unknown): CiFnRunView {
  if (!isRecord(value)
    || typeof value.runId !== "string"
    || typeof value.status !== "string"
    || !Array.isArray(value.jobs)) {
    throw new AdminError(
      "dependency_unavailable",
      "CiFn control plane returned an invalid run representation.",
    );
  }
  return value as unknown as CiFnRunView;
}

function jobIdentity(runId: string, jobKey: string): string {
  return `${encodeURIComponent(runId)}::${encodeURIComponent(jobKey)}`;
}

function parseJobIdentity(value: string): { runId: string; jobKey: string } {
  const separator = value.indexOf("::");
  if (separator <= 0 || separator === value.length - 2) {
    throw new AdminError(
      "invalid_argument",
      "CiFn job id must be the function-owned run/job identity returned by listJobs.",
    );
  }
  try {
    return {
      runId: decodeURIComponent(value.slice(0, separator)),
      jobKey: decodeURIComponent(value.slice(separator + 2)),
    };
  } catch (cause) {
    throw new AdminError("invalid_argument", "CiFn job id is malformed.", { cause });
  }
}

function normalizeJob(runId: string, value: CiFnRunView["jobs"][number]): CiFnJobView {
  return {
    ...value,
    id: jobIdentity(runId, value.jobKey),
    runId,
  };
}

function parseOffset(cursor: string | undefined): number {
  if (!cursor) return 0;
  const match = /^offset:(\d+)$/.exec(cursor);
  if (!match) throw new AdminError("invalid_argument", "CiFn log cursor is invalid.");
  return Number(match[1]);
}

export function createCiFnControlPlaneAdminService(
  options: CiFnControlPlaneAdminServiceOptions,
): CiFnAdminService {
  if (!options.connection && !options.resolveConnection) {
    throw new Error("CiFn admin service requires connection or resolveConnection.");
  }

  const connectionFor = async (context: AdminOperationContext) => {
    const connection = options.resolveConnection
      ? await options.resolveConnection(context)
      : options.connection!;
    return { ...connection, baseUrl: trimBaseUrl(connection.baseUrl) };
  };

  const request = async <T>(
    context: AdminOperationContext,
    path: string,
    init: RequestInit = {},
  ): Promise<T> => {
    const connection = await connectionFor(context);
    const configuredHeaders = typeof connection.headers === "function"
      ? await connection.headers()
      : connection.headers;
    const headers = new Headers(configuredHeaders);
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    headers.set("accept", "application/json");
    if (connection.apiKey) {
      headers.set("authorization", `Bearer ${connection.apiKey}`);
      headers.set("x-api-key", connection.apiKey);
    }
    headers.set("x-request-id", context.requestId);
    if (context.correlationId) headers.set("x-correlation-id", context.correlationId);
    if (context.idempotencyKey) headers.set("idempotency-key", context.idempotencyKey);
    headers.set("x-cifn-admin-actor-id", context.actor.id);
    headers.set("x-cifn-admin-source", context.source);
    if (context.scope.organizationId) headers.set("x-cifn-organization-id", context.scope.organizationId);
    if (context.scope.workspaceId) headers.set("x-cifn-workspace-id", context.scope.workspaceId);
    if (context.scope.projectId) headers.set("x-cifn-project-id", context.scope.projectId);
    if (context.scope.environmentId) headers.set("x-cifn-environment-id", context.scope.environmentId);
    if (context.scope.namespace) headers.set("x-cifn-namespace", context.scope.namespace);
    if (context.scope.region) headers.set("x-cifn-region", context.scope.region);
    const fetcher = connection.fetch ?? globalThis.fetch;
    if (!fetcher) throw new AdminError("dependency_unavailable", "No fetch implementation is available for CiFn.");
    const response = await fetcher(`${connection.baseUrl}${path}`, {
      ...init,
      headers,
      signal: context.signal ?? init.signal,
    });
    const payload = await response.json().catch(() => undefined) as
      | ControlPlaneSuccessEnvelope<T>
      | ControlPlaneErrorEnvelope
      | undefined;
    if (!response.ok || !payload || payload.ok !== true) {
      throw adminErrorForControlPlane(response, payload);
    }
    return payload.data;
  };

  const getRun = async (
    input: CiFnGetRunInput,
    context: AdminOperationContext,
  ): Promise<CiFnGetRunOutput> => {
    const run = assertRun(await request<unknown>(
      context,
      `/api/v1/runs/${encodeURIComponent(input.id)}`,
    ));
    return {
      item: {
        ...run,
        jobs: run.jobs.map((job) => normalizeJob(run.runId, job)),
      },
    };
  };

  const listArtifacts = async (
    input: CiFnListArtifactsInput,
    context: AdminOperationContext,
  ): Promise<CiFnListArtifactsOutput> => {
    const { runId } = input.filter;
    const data = await request<{ artifacts: Array<{ name: string; fileId: string; url?: string }> }>(
      context,
      `/api/v1/runs/${encodeURIComponent(runId)}/artifacts`,
    );
    return {
      items: data.artifacts.map((artifact): CiFnArtifactView => ({
        id: artifact.fileId,
        runId,
        name: artifact.name,
        fileId: artifact.fileId,
        ...(artifact.url ? {
          url: artifact.url,
          signedExternal: artifact.url.startsWith("https://"),
        } : {}),
      })),
      nextCursor: null,
    };
  };

  const triggerRun = async (
    input: CiFnTriggerRunInput,
    context: AdminOperationContext,
  ): Promise<CiFnTriggerRunOutput> => {
    const trigger = input.trigger ?? { type: "workflow_dispatch" as const };
    const data = await request<{
      runId: string;
      status: CiFnTriggerRunOutput["status"];
      createdAt: string;
    }>(context, "/api/v1/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        trigger,
        ...(input.pipelineRef ? { pipelineRef: input.pipelineRef } : {}),
        ...(input.pipelineSpec ? { pipelineSpec: input.pipelineSpec } : {}),
      }),
    });
    return {
      accepted: true,
      ...data,
      operationReference: `cifn:run:${data.runId}`,
    };
  };

  return {
    async listRuns(input, context) {
      const query = new URLSearchParams();
      query.set("limit", String(input.limit ?? 50));
      if (input.cursor) query.set("cursor", input.cursor);
      if (input.filter?.status) query.set("status", input.filter.status);
      const data = await request<{ runs: unknown[]; nextCursor?: string | null }>(
        context,
        `/api/v1/runs?${query}`,
      );
      return {
        items: data.runs.map((candidate) => {
          const run = assertRun(candidate);
          return { ...run, jobs: run.jobs.map((job) => normalizeJob(run.runId, job)) };
        }),
        nextCursor: data.nextCursor ?? null,
      };
    },
    getRun,
    async listJobs(input, context) {
      const run = (await getRun({ id: input.filter.runId }, context)).item;
      return { items: run.jobs, nextCursor: null };
    },
    async getJob(input: CiFnGetJobInput, context: AdminOperationContext): Promise<CiFnGetJobOutput> {
      const identity = parseJobIdentity(input.id);
      const run = (await getRun({ id: identity.runId }, context)).item;
      const job = run.jobs.find((candidate) => candidate.jobKey === identity.jobKey);
      if (!job) throw new AdminError("not_found", `CiFn job ${identity.jobKey} was not found in run ${identity.runId}.`);
      return { item: job };
    },
    async listLogs(input, context) {
      const { runId, jobKey } = input.filter;
      const data = await request<{ lines: Array<{ line: string; timestamp: string; stepKey: string }> }>(
        context,
        `/api/v1/runs/${encodeURIComponent(runId)}/jobs/${encodeURIComponent(jobKey)}/logs`,
      );
      const source = input.tail ? data.lines.slice(-input.tail) : data.lines;
      const start = parseOffset(input.cursor);
      const limit = Math.min(input.limit ?? 1000, 5000);
      const lines = source.slice(start, start + limit);
      const next = start + lines.length < source.length ? `offset:${start + lines.length}` : null;
      return {
        items: lines.map((line, index) => ({
          id: `${jobIdentity(runId, jobKey)}::${start + index}`,
          runId,
          jobKey,
          ...line,
        })),
        nextCursor: next,
        capabilities: { follow: true, download: false },
        followIntervalMs: 3_000,
      };
    },
    listArtifacts,
    triggerRun,
    async retryRun(input, context): Promise<CiFnRetryRunOutput> {
      const original = (await getRun({ id: input.id }, context)).item;
      if (!original.pipelineRef.repo || !original.pipelineRef.ref) {
        throw new AdminError(
          "precondition_failed",
          "This run used an inline pipeline and cannot be replayed because CiFn does not retain the original pipeline document.",
        );
      }
      const retried = await triggerRun({
        trigger: {
          type: "workflow_dispatch",
          payload: { retryOf: original.runId, reason: input.reason },
        },
        pipelineRef: original.pipelineRef,
      }, context);
      return { ...retried, retriedRunId: original.runId };
    },
    async cancelRun(input, context): Promise<CiFnRunMutationOutput> {
      const data = await request<{ runId: string; status: CiFnRunMutationOutput["status"] }>(
        context,
        `/api/v1/runs/${encodeURIComponent(input.id)}/cancel`,
        { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
      );
      return {
        accepted: true,
        ...data,
        operationReference: `cifn:run:${data.runId}`,
      };
    },
    async downloadArtifact(input: CiFnDownloadArtifactInput, context: AdminOperationContext): Promise<CiFnDownloadArtifactOutput> {
      const artifacts = await listArtifacts({ filter: { runId: input.runId } }, context);
      const artifact = artifacts.items.find((candidate) => candidate.id === input.id);
      if (!artifact) throw new AdminError("not_found", `CiFn artifact ${input.id} was not found in run ${input.runId}.`);
      if (!artifact.url || !artifact.url.startsWith("https://")) {
        throw new AdminError(
          "precondition_failed",
          "The configured CiFn artifact adapter did not provide an HTTPS signed download URL.",
        );
      }
      return {
        accepted: true,
        artifactId: artifact.id,
        downloadUrl: artifact.url,
        signedExternal: true,
        operationReference: `cifn:artifact:${artifact.id}`,
      };
    },
  };
}
