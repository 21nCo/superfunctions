import {
  McpFnError,
  McpFnValidationError,
  type McpFnRequestExtra,
  type McpFnSchemaIssue,
  type McpFnToolDefinition,
} from "@mcpfn/core";

/** The MCP error code a scope-gated tool answers when the session lacks a scope. */
export const DATAFN_INSUFFICIENT_SCOPE = "insufficient_scope";

const ALL_SCOPES = "*";

const TOOL_FIELDS = [
  "name",
  "title",
  "description",
  "inputSchema",
  "outputSchema",
  "annotations",
  "execution",
  "icons",
  "metadata",
  "handler",
  "taskHandler",
  "handleInvalidArguments",
] as const;

// One `<owner>:<action>` segment, as AuthFn shapes scopes (no AuthFn import).
const SCOPE_SEGMENT = /^[a-z0-9][a-z0-9_.-]{0,63}$/;

function splitScope(scope: string): { owner: string; action: string } | undefined {
  const separator = scope.indexOf(":");
  if (separator <= 0 || separator !== scope.lastIndexOf(":")) return undefined;
  return { owner: scope.slice(0, separator), action: scope.slice(separator + 1) };
}

function isConcreteScope(scope: unknown): scope is string {
  if (typeof scope !== "string") return false;
  const parts = splitScope(scope);
  return parts !== undefined &&
    SCOPE_SEGMENT.test(parts.owner) &&
    SCOPE_SEGMENT.test(parts.action);
}

/** Checks a declared list of needed scopes: unique, concrete `<owner>:<action>` strings. */
export function validateNeededScopes(label: string, scopes: unknown): string[] {
  if (
    !Array.isArray(scopes) ||
    scopes.length === 0 ||
    new Set(scopes).size !== scopes.length ||
    !scopes.every(isConcreteScope)
  ) {
    throw new McpFnValidationError(
      `${label} must be a non-empty, unique list of concrete <owner>:<action> scopes without wildcards`,
    );
  }
  return [...(scopes as string[])];
}

/** Granted exactly, by `<owner>:*` for the scope's owner, or by `*`. */
function isGranted(granted: ReadonlySet<string>, needed: string): boolean {
  if (granted.has(ALL_SCOPES) || granted.has(needed)) return true;
  return granted.has(`${splitScope(needed)!.owner}:*`);
}

function readGrant(value: unknown): Set<string> {
  if (!Array.isArray(value)) return new Set();
  return new Set(value.filter((scope): scope is string => typeof scope === "string"));
}

export type SessionScopesResolver<TContext> = (
  context: TContext,
  extra: McpFnRequestExtra,
) => readonly string[] | Promise<readonly string[]>;

/**
 * Records which tools need which scopes and answers both the visibility hook
 * and the handler-side check.
 */
export class ScopeGate<TContext> {
  private readonly needed = new Map<string, readonly string[]>();
  // A tools/list asks the hook about every tool at once, synchronously, with
  // one context and extra: share one resolution among those questions while
  // it is pending. A settled grant is never reused, so a later list (or a
  // direct caller reusing `extra`) sees the scopes as they are then.
  private readonly pending = new WeakMap<
    object,
    { context: TContext; grant: Promise<Set<string>> }
  >();

  constructor(private readonly resolver: SessionScopesResolver<TContext> | undefined) {}

  get enabled(): boolean {
    return this.resolver !== undefined;
  }

  requiredScopes(toolName: string): readonly string[] | undefined {
    return this.needed.get(toolName);
  }

  private resolve(context: TContext, extra: McpFnRequestExtra): Promise<Set<string>> {
    return Promise.resolve()
      .then(() => this.resolver!(context, extra))
      .then(readGrant);
  }

  private sharedGrant(context: TContext, extra: McpFnRequestExtra): Promise<Set<string>> {
    if (!extra || typeof extra !== "object") return this.resolve(context, extra);
    const shared = this.pending.get(extra);
    if (shared && shared.context === context) return shared.grant;
    const grant = this.resolve(context, extra);
    this.pending.set(extra, { context, grant });
    const release = () => {
      if (this.pending.get(extra)?.grant === grant) this.pending.delete(extra);
    };
    grant.then(release, release);
    return grant;
  }

  private static missing(scopes: readonly string[], granted: ReadonlySet<string>): string[] {
    return scopes.filter((scope) => !isGranted(granted, scope));
  }

  /** Hides a gated tool from tools/list; every other decision is left to the call. */
  async visible(input: {
    tool: { name: string };
    context: TContext;
    extra: McpFnRequestExtra;
    requestKind: string;
  }): Promise<boolean> {
    const scopes = this.needed.get(input.tool.name);
    if (!scopes || input.requestKind !== "tools/list") return true;
    const granted = await this.sharedGrant(input.context, input.extra);
    return ScopeGate.missing(scopes, granted).length === 0;
  }

  /** Resolves the session's scopes afresh for every call. */
  private async assert(
    toolName: string,
    scopes: readonly string[],
    context: TContext,
    extra: McpFnRequestExtra,
  ): Promise<void> {
    const missingScopes = ScopeGate.missing(scopes, await this.resolve(context, extra));
    if (missingScopes.length) {
      throw new McpFnError(
        DATAFN_INSUFFICIENT_SCOPE,
        `Tool ${toolName} needs scopes the session was not granted: ${missingScopes.join(", ")}`,
        { requiredScopes: [...scopes], missingScopes },
      );
    }
  }

  /**
   * Returns the definition with its handler checking the scopes before any
   * other work, and records the tool as gated.
   *
   * Gated tools cannot support task execution: McpFn validates a task's
   * arguments before any tool callback runs and answers a failed task
   * creation with a bare JSON-RPC error, so neither order nor the
   * `insufficient_scope` details could be kept. A task-augmented call to a
   * gated tool gets McpFn's usual "does not support task augmentation" error.
   */
  wrap(
    definition: McpFnToolDefinition<TContext>,
    scopes: readonly string[],
  ): McpFnToolDefinition<TContext> {
    // Read each definition field once through the caller, as the registry
    // does, so getters and class methods keep working.
    const source = definition as unknown as Record<string, unknown>;
    const fields: Record<string, unknown> = {};
    for (const key of TOOL_FIELDS) {
      const value = source[key];
      if (value !== undefined) fields[key] = value;
    }
    const name = fields.name as string;
    const handler = fields.handler;
    if (typeof handler !== "function") {
      throw new McpFnValidationError(`Tool ${String(name)} handler must be a function`);
    }
    const execution = fields.execution as McpFnToolDefinition<TContext>["execution"];
    if (
      fields.taskHandler !== undefined ||
      (execution !== null && typeof execution === "object" &&
        (execution.taskSupport ?? "forbidden") !== "forbidden")
    ) {
      throw new McpFnValidationError(
        `Tool ${String(name)} declares scopes, so it cannot support task execution`,
      );
    }
    const needed = Object.freeze([...scopes]);
    const invalidArguments = fields.handleInvalidArguments;
    return {
      ...fields,
      // McpFn validates arguments before the handler runs: check scopes first
      // there too, so an out-of-scope call learns no more than
      // insufficient_scope. Without a host handler, fail as McpFn does. (McpFn
      // refuses arguments over its size limit before this, and client-profile
      // argument enrichment runs before it too.)
      handleInvalidArguments: async (
        args: Record<string, unknown>,
        issues: McpFnSchemaIssue[],
        context: TContext,
        extra: McpFnRequestExtra,
      ) => {
        await this.assert(name, needed, context, extra);
        if (typeof invalidArguments === "function") {
          return invalidArguments.call(definition, args, issues, context, extra);
        }
        throw new McpFnValidationError(`Invalid arguments for ${name}`, { issues });
      },
      handler: async (
        args: Record<string, unknown>,
        context: TContext,
        extra: McpFnRequestExtra,
      ) => {
        await this.assert(name, needed, context, extra);
        return handler.call(definition, args, context, extra);
      },
    } as McpFnToolDefinition<TContext>;
  }

  /** Records a tool as gated once the registry accepted it. */
  record(toolName: string, scopes: readonly string[]): void {
    this.needed.set(toolName, Object.freeze([...scopes]));
  }
}
