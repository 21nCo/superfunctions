import type { AdminOperationContext, AdminOperationDefinition } from "./types.js";

function isImplicitSecretKey(key: string): boolean {
  const normalized = key.replace(/[-_\s]/g, "").toLowerCase();
  if (
    /(?:password|passwd|secret|token|authorization|cookie|credential|privatekey|apikey)/.test(
      normalized,
    )
  ) {
    return true;
  }
  return [
    "code",
    "otp",
    "otpcode",
    "recoverycode",
    "recoverycodes",
    "session",
    "sessionid",
    "verificationcode",
  ].includes(normalized);
}

export interface AdminAuditEvent {
  id: string;
  timestamp: string;
  actorId: string;
  actorType?: string;
  scope: AdminOperationContext["scope"];
  moduleId: string;
  operationId: string;
  classification: AdminOperationDefinition["safety"]["classification"];
  permission: string;
  source: string;
  requestId: string;
  correlationId?: string;
  idempotencyKey?: string;
  target:
    | { resource: string; collection: true }
    | { resource: string; idInput: string; id?: string | number };
  input: unknown;
  outcome: "attempted" | "succeeded" | "failed" | "denied" | "replayed";
  errorCode?: string;
  durationMs: number;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface AdminAuditSink {
  write(event: AdminAuditEvent): Promise<void> | void;
}

export type AdminAuditIdFactory = () => string;

export function createAdminAuditId(): string {
  return `audit_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}

export function redactAdminValue(
  value: unknown,
  sensitiveFields: readonly string[] = [],
  seen = new WeakSet<object>(),
): unknown {
  return redactValue(value, sensitiveFields, true, seen);
}

export function redactDeclaredAdminValue(
  value: unknown,
  sensitiveFields: readonly string[] = [],
  seen = new WeakSet<object>(),
): unknown {
  return redactValue(value, sensitiveFields, false, seen);
}

function redactValue(
  value: unknown,
  sensitiveFields: readonly string[],
  redactImplicitSecrets: boolean,
  seen: WeakSet<object>,
): unknown {
  const normalizeKey = (field: string) =>
    field.replace(/[-_\s]/g, "").toLowerCase();
  const explicit = new Set(sensitiveFields.map(normalizeKey));
  const visit = (current: unknown): unknown => {
    if (!current || typeof current !== "object") return current;
    if (seen.has(current)) return "[Circular]";
    seen.add(current);
    const redacted = Array.isArray(current) ? current.map(visit) : Object.fromEntries(Object.entries(current as Record<string, unknown>).map(([key, item]) => [
      key,
      (redactImplicitSecrets && isImplicitSecretKey(key)) || explicit.has(normalizeKey(key)) ? "[REDACTED]" : visit(item),
    ]));
    seen.delete(current);
    return redacted;
  };
  return visit(value);
}

export class MemoryAdminAuditSink implements AdminAuditSink {
  readonly events: AdminAuditEvent[] = [];
  write(event: AdminAuditEvent): void { this.events.push(structuredClone(event)); }
}
