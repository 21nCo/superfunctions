import { createAdminAuditId, redactAdminValue, redactDeclaredAdminValue, type AdminAuditIdFactory, type AdminAuditSink } from "./audit.js";
import { AdminError, normalizeAdminError } from "./errors.js";
import {
  beginAdminIdempotency,
  type AdminIdempotencyClaim,
  type AdminIdempotencyIdentity,
  type AdminIdempotencyStore,
} from "./idempotency.js";
import type { AdminCapabilityRegistry, AdminRegistryOperation } from "./registry.js";
import { assertAdminValue, validateAdminValue } from "./validator.js";
import type {
  AdminOperationContext,
  AdminOperationError,
  AdminOperationResult,
  AdminResult,
} from "./types.js";

export interface AdminPolicyDecision {
  allowed: boolean;
  reason?: string;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface AdminPolicyEvaluator {
  authorize(request: {
    entry: AdminRegistryOperation;
    input: unknown;
    context: AdminOperationContext;
  }): Promise<AdminPolicyDecision> | AdminPolicyDecision;
}

export interface AdminConfirmationVerifier {
  verify(request: {
    entry: AdminRegistryOperation;
    input: unknown;
    context: AdminOperationContext;
    token: string;
  }): Promise<boolean> | boolean;
}

export interface CreateAdminDispatcherOptions {
  registry: AdminCapabilityRegistry;
  policy?: AdminPolicyEvaluator;
  confirmation?: AdminConfirmationVerifier;
  audit?: AdminAuditSink;
  idempotency?: AdminIdempotencyStore;
  createAuditId?: AdminAuditIdFactory;
  now?: () => Date;
}

export interface AdminDispatchRequest {
  operationId: string;
  input: unknown;
  context: AdminOperationContext;
}

function deepFreezeAdminValue<T>(value: T): T {
  if (!value || typeof value !== "object") return value;
  if (typeof AbortSignal !== "undefined" && value instanceof AbortSignal) return value;
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreezeAdminValue(child);
  }
  return Object.freeze(value);
}

function immutableDispatchRequest(request: AdminDispatchRequest): AdminDispatchRequest {
  const { signal, ...cloneableContext } = request.context;
  const context = structuredClone(cloneableContext) as Omit<AdminOperationContext, "signal">;
  return {
    operationId: request.operationId,
    input: deepFreezeAdminValue(structuredClone(request.input)),
    context: deepFreezeAdminValue({ ...context, ...(signal ? { signal } : {}) }),
  };
}

export class AdminDispatcher {
  private readonly registry: AdminCapabilityRegistry;
  private readonly policy?: AdminPolicyEvaluator;
  private readonly confirmation?: AdminConfirmationVerifier;
  private readonly audit?: AdminAuditSink;
  private readonly idempotency?: AdminIdempotencyStore;
  private readonly createAuditId: AdminAuditIdFactory;
  private readonly now: () => Date;

  constructor(options: CreateAdminDispatcherOptions) {
    this.registry = options.registry;
    this.policy = options.policy;
    this.confirmation = options.confirmation;
    this.audit = options.audit;
    this.idempotency = options.idempotency;
    this.createAuditId = options.createAuditId ?? createAdminAuditId;
    this.now = options.now ?? (() => new Date());
  }

  async dispatch<T = unknown>(request: AdminDispatchRequest): Promise<AdminResult<T>> {
    const startedAt = this.now();
    let entry: AdminRegistryOperation | undefined;
    let auditId: string | undefined;
    let idempotencyClaim: AdminIdempotencyClaim | undefined;
    let idempotencyIdentity: AdminIdempotencyIdentity | undefined;
    let inputValidated = false;
    let attemptedAuditAttempted = false;
    let terminalAuditAttempted = false;
    let terminalAuditWritten = false;
    let domainInvoked = false;
    let domainCompleted = false;
    let policyMetadata: Readonly<Record<string, unknown>> | undefined;
    try {
      this.assertContext(request.context);
      entry = this.registry.requireOperation(request.operationId);
      const inputSchema = entry.operation.inputSchema;
      if (!inputSchema) throw new AdminError("internal", `Operation ${entry.operation.id} has no input schema.`);
      assertAdminValue(inputSchema, request.input);
      inputValidated = true;
      // Policy, confirmation, audit and domain execution observe one immutable
      // post-validation snapshot, preventing hooks from changing IDs, payloads,
      // actor permissions or tenant scope after validation.
      request = immutableDispatchRequest(request);

      if (!entry.manifest.scopeLevels.some((level) => this.scopeSupports(level, request.context))) {
        throw new AdminError("forbidden", "The operation is unavailable at the active scope.");
      }
      const permissionDecision = this.defaultPolicy(entry, request.context);
      if (!permissionDecision.allowed) {
        throw new AdminError("forbidden", "The active actor cannot perform this operation.");
      }
      const decision = this.policy
        ? await this.policy.authorize({ entry, input: request.input, context: request.context })
        : permissionDecision;
      policyMetadata = decision.metadata;
      if (!decision.allowed) throw new AdminError("forbidden", decision.reason || "The active actor cannot perform this operation.");

      if (entry.operation.safety.requiresConfirmation) {
        const token = request.context.confirmationToken;
        if (!token) throw new AdminError("precondition_failed", "This operation requires explicit confirmation.");
        if (!this.confirmation) {
          throw new AdminError("dependency_unavailable", "Administration confirmation verification is unavailable.");
        }
        if (!(await this.confirmation.verify({ entry, input: request.input, context: request.context, token }))) {
          throw new AdminError("precondition_failed", "The operation confirmation is invalid or expired.");
        }
      }

      if (entry.operation.safety.audit === "required" && !this.audit) {
        throw new AdminError("dependency_unavailable", "A required administration audit sink is unavailable.");
      }

      const identity = this.idempotencyIdentity(entry, request.context);
      if (entry.operation.safety.classification !== "read" && entry.operation.safety.idempotent && !identity) {
        throw new AdminError("precondition_failed", "This operation requires an idempotency key.");
      }
      if (identity && !this.idempotency) {
        throw new AdminError("dependency_unavailable", "Durable administration idempotency storage is unavailable.");
      }
      if (identity && this.idempotency) {
        const reservation = await beginAdminIdempotency<T>(this.idempotency, identity, request.input);
        if (reservation.status === "replay") {
          const prior = reservation.record.result;
          const originalAuditId = reservation.record.auditId ?? prior.auditId;
          let replayAuditId: string | undefined;
          if (this.shouldAudit(entry)) {
            terminalAuditAttempted = true;
            const candidateAuditId = this.createAuditId();
            try {
              await this.writeAudit(entry, request, startedAt, candidateAuditId, "replayed", undefined, policyMetadata);
              terminalAuditWritten = true;
              replayAuditId = candidateAuditId;
            } catch (error) {
              if (entry.operation.safety.audit === "required") throw error;
            }
          }
          const { auditId: _originalReceipt, ...priorWithoutReceipt } = prior;
          return {
            ...priorWithoutReceipt,
            ...(replayAuditId ? { auditId: replayAuditId } : {}),
            meta: {
              ...prior.meta,
              idempotencyReplay: true,
              ...(originalAuditId ? { originalAuditId } : {}),
            },
          };
        }
        idempotencyClaim = reservation.claim;
        idempotencyIdentity = identity;
      }

      if (
        entry.operation.safety.classification !== "read" &&
        entry.operation.safety.audit === "required"
      ) {
        attemptedAuditAttempted = true;
        await this.writeAudit(
          entry,
          request,
          startedAt,
          this.createAuditId(),
          "attempted",
          undefined,
          policyMetadata,
        );
      }

      domainInvoked = true;
      const result = await entry.adapter.invoke<T>(entry.operation.id, request.input, request.context);
      const outputSchema = entry.operation.outputSchema;
      if (!outputSchema) throw new AdminError("internal", `Operation ${entry.operation.id} has no output schema.`);
      if (validateAdminValue(outputSchema, result.data).length > 0) {
        throw new AdminError("internal", "The administration service returned an invalid response.");
      }
      if (
        result.page !== undefined &&
        (result.page === null ||
          typeof result.page !== "object" ||
          (result.page.nextCursor !== undefined &&
            result.page.nextCursor !== null &&
            typeof result.page.nextCursor !== "string") ||
          (result.page.hasMore !== undefined &&
            typeof result.page.hasMore !== "boolean"))
      ) {
        throw new AdminError("internal", "The administration service returned invalid pagination metadata.");
      }
      if (
        result.warnings !== undefined &&
        (!Array.isArray(result.warnings) ||
          result.warnings.some((warning) => typeof warning !== "string"))
      ) {
        throw new AdminError("internal", "The administration service returned invalid warnings.");
      }
      if (
        result.meta !== undefined &&
        (result.meta === null ||
          typeof result.meta !== "object" ||
          Array.isArray(result.meta))
      ) {
        throw new AdminError("internal", "The administration service returned invalid metadata.");
      }
      const externalData = redactDeclaredAdminValue(result.data, entry.operation.redaction?.outputFields ?? []) as T;
      const externalMeta = result.meta === undefined
        ? undefined
        : redactDeclaredAdminValue(
            result.meta,
            entry.operation.redaction?.outputFields ?? [],
          ) as Readonly<Record<string, unknown>>;
      domainCompleted = true;

      if (this.shouldAudit(entry)) {
        const candidateAuditId = this.createAuditId();
        terminalAuditAttempted = true;
        try {
          await this.writeAudit(entry, request, startedAt, candidateAuditId, "succeeded", undefined, policyMetadata);
          terminalAuditWritten = true;
          auditId = candidateAuditId;
        } catch (error) {
          if (entry.operation.safety.audit === "required") throw error;
        }
      }
      const response: AdminOperationResult<T> = {
        data: externalData,
        ok: true,
        ...(result.page ? { page: result.page } : {}),
        ...(result.warnings ? { warnings: result.warnings } : {}),
        requestId: request.context.requestId,
        correlationId: request.context.correlationId,
        ...(auditId ? { auditId } : {}),
        ...(externalMeta ? { meta: externalMeta } : {}),
      };
      if (idempotencyClaim && idempotencyIdentity && this.idempotency) {
        try {
          await this.idempotency.complete(idempotencyClaim, {
            identity: idempotencyIdentity,
            fingerprint: idempotencyClaim.fingerprint,
            result: response,
            auditId,
            createdAt: this.now().toISOString(),
          });
        } catch (cause) {
          throw new AdminError(
            "dependency_unavailable",
            "The domain operation completed, but its idempotency result could not be persisted; reconciliation is required.",
            { retryable: false, cause },
          );
        }
      }
      return response;
    } catch (error) {
      const normalized = normalizeAdminError(error, {
        requestId: request.context?.requestId,
        correlationId: request.context?.correlationId,
      });
      const safeNormalized = normalized.error.details === undefined
        ? normalized
        : {
            ...normalized,
            error: {
              ...normalized.error,
              details: redactAdminValue(normalized.error.details, [
                ...(entry?.operation.redaction?.inputFields ?? []),
                ...(entry?.operation.redaction?.outputFields ?? []),
              ]),
            },
          };
      if (
        entry &&
        inputValidated &&
        this.shouldAudit(entry) &&
        this.audit &&
        !terminalAuditAttempted &&
        !(attemptedAuditAttempted && !domainInvoked)
      ) {
        const failureAuditId = this.createAuditId();
        auditId = undefined;
        terminalAuditAttempted = true;
        try {
          await this.writeAudit(
            entry,
            request,
            startedAt,
            failureAuditId,
            normalized.error.code === "forbidden" || normalized.error.code === "precondition_failed" ? "denied" : "failed",
            normalized.error.code,
            policyMetadata,
          );
          terminalAuditWritten = true;
          auditId = failureAuditId;
        } catch {
          auditId = undefined;
          // The original safe error remains authoritative; deployments observe audit sink failures separately.
        }
      }
      const failedResult = auditId && terminalAuditWritten ? { ...safeNormalized, auditId } : safeNormalized;
      if (idempotencyClaim && idempotencyIdentity && this.idempotency) {
        try {
          if (!domainInvoked) {
            await this.idempotency.release(idempotencyClaim);
          } else if (!domainCompleted) {
            // Once the handler was entered, even retryable failures stay
            // fenced: execution may have committed before the error surfaced.
            await this.idempotency.complete(idempotencyClaim, {
              identity: idempotencyIdentity,
              fingerprint: idempotencyClaim.fingerprint,
              result: failedResult,
              auditId,
              createdAt: this.now().toISOString(),
            });
          }
        } catch {
          // Preserve the operation error. Durable stores retain/fence claims
          // whose release or completion could not be proven.
        }
      }
      return failedResult;
    }
  }

  private assertContext(context: AdminOperationContext): void {
    if (typeof context?.actor?.id !== "string" || !context.actor.id.trim()) throw new AdminError("unauthenticated", "An authenticated administration actor is required.");
    if (typeof context.requestId !== "string" || !context.requestId.trim() || typeof context.source !== "string" || !context.source.trim()) {
      throw new AdminError("invalid_argument", "Request identity and source are required.");
    }
    const required = ["organizationId", "workspaceId", "projectId", "environmentId"] as const;
    for (const key of required) {
      if (typeof context.scope?.[key] !== "string" || !context.scope[key].trim()) {
        throw new AdminError("invalid_argument", `Administration scope requires ${key}.`);
      }
    }
  }

  private scopeSupports(level: "organization" | "workspace" | "project" | "environment", context: AdminOperationContext): boolean {
    return level === "organization" ? Boolean(context.scope.organizationId)
      : level === "workspace" ? Boolean(context.scope.workspaceId)
      : level === "project" ? Boolean(context.scope.projectId)
      : Boolean(context.scope.environmentId);
  }

  private defaultPolicy(entry: AdminRegistryOperation, context: AdminOperationContext): AdminPolicyDecision {
    const permissions = context.actor.permissions ?? [];
    return { allowed: permissions.includes("*") || permissions.includes(entry.operation.permission) };
  }

  private idempotencyIdentity(entry: AdminRegistryOperation, context: AdminOperationContext): AdminIdempotencyIdentity | undefined {
    if (entry.operation.safety.classification === "read" || !context.idempotencyKey || !entry.operation.safety.idempotent) return undefined;
    return { key: context.idempotencyKey, actorId: context.actor.id, scope: context.scope, operationId: entry.operation.id };
  }

  private shouldAudit(entry: AdminRegistryOperation): boolean {
    return entry.operation.safety.audit === "required" || (entry.operation.safety.audit === "optional" && Boolean(this.audit));
  }

  private async writeAudit(
    entry: AdminRegistryOperation,
    request: AdminDispatchRequest,
    startedAt: Date,
    auditId: string,
    outcome: "attempted" | "succeeded" | "failed" | "denied" | "replayed",
    errorCode?: string,
    metadata?: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    if (!this.audit) {
      if (entry.operation.safety.audit === "required") throw new AdminError("dependency_unavailable", "A required administration audit sink is unavailable.");
      return;
    }
    try {
      const safeInput = redactAdminValue(request.input, entry.operation.redaction?.inputFields ?? []);
      const target = entry.operation.target.collection === true
        ? { resource: entry.operation.target.resource, collection: true as const }
        : {
            resource: entry.operation.target.resource,
            idInput: entry.operation.target.idInput,
            ...(() => {
              const value = safeInput && typeof safeInput === "object" && !Array.isArray(safeInput)
                ? (safeInput as Record<string, unknown>)[entry.operation.target.idInput]
                : undefined;
              return typeof value === "string" || typeof value === "number" ? { id: value } : {};
            })(),
          };
      await this.audit.write({
        id: auditId,
        timestamp: this.now().toISOString(),
        actorId: request.context.actor.id,
        actorType: request.context.actor.type,
        scope: request.context.scope,
        moduleId: entry.moduleId,
        operationId: entry.operation.id,
        classification: entry.operation.safety.classification,
        permission: entry.operation.permission,
        source: request.context.source,
        requestId: request.context.requestId,
        correlationId: request.context.correlationId,
        idempotencyKey: request.context.idempotencyKey,
        target,
        input: safeInput,
        outcome,
        errorCode,
        durationMs: Math.max(0, this.now().getTime() - startedAt.getTime()),
        ...(metadata === undefined
          ? {}
          : {
              metadata: redactAdminValue(metadata, [
                ...(entry.operation.redaction?.inputFields ?? []),
                ...(entry.operation.redaction?.outputFields ?? []),
              ]) as Readonly<Record<string, unknown>>,
            }),
      });
    } catch (cause) {
      throw new AdminError(
        "dependency_unavailable",
        "The administration audit event could not be recorded.",
        { cause },
      );
    }
  }
}

export function createAdminDispatcher(options: CreateAdminDispatcherOptions): AdminDispatcher {
  return new AdminDispatcher(options);
}
