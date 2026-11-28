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

/** Checks a declared list of needed scopes: concrete, non-wildcard strings. */
export function validateNeededScopes(label: string, scopes: unknown): string[] {
  if (
    !Array.isArray(scopes) ||
    scopes.length === 0 ||
    new Set(scopes).size !== scopes.length ||
    scopes.some((scope) =>
      typeof scope !== "string" ||
      !scope ||
      /\s/.test(scope) ||
      scope === ALL_SCOPES ||
      scope.endsWith(":*"))
  ) {
    throw new McpFnValidationError(
      `${label} must be a non-empty, unique list of scope strings without wildcards`,
    );
  }
  return [...(scopes as string[])];
}

/** Granted exactly, by `<owner>:*` for the scope's owner, or by `*`. */
function isGranted(granted: ReadonlySet<string>, needed: string): boolean {
  if (granted.has(ALL_SCOPES) || granted.has(needed)) return true;
  const separator = needed.indexOf(":");
  return separator > 0 && granted.has(`${needed.slice(0, separator)}:*`);
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
 * and the handler-side check from one per-request grant.
 */
export class ScopeGate<TContext> {
  private readonly needed = new Map<string, readonly string[]>();
  // One resolution per request: a tools/list asks for every tool at once.
  private readonly grants = new WeakMap<object, Promise<Set<string>>>();

  constructor(private readonly resolver: SessionScopesResolver<TContext> | undefined) {}

  get enabled(): boolean {
    return this.resolver !== undefined;
  }

  requiredScopes(toolName: string): readonly string[] | undefined {
    return this.needed.get(toolName);
  }

  private grant(context: TContext, extra: McpFnRequestExtra): Promise<Set<string>> {
    const resolve = () =>
      Promise.resolve()
        .then(() => this.resolver!(context, extra))
        .then(readGrant);
    if (!extra || typeof extra !== "object") return resolve();
    let grant = this.grants.get(extra);
    if (!grant) {
      grant = resolve();
      this.grants.set(extra, grant);
    }
    return grant;
  }

  private async missing(
    scopes: readonly string[],
    context: TContext,
    extra: McpFnRequestExtra,
  ): Promise<string[]> {
    const granted = await this.grant(context, extra);
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
    return (await this.missing(scopes, input.context, input.extra)).length === 0;
  }

  private async assert(
    toolName: string,
    scopes: readonly string[],
    context: TContext,
    extra: McpFnRequestExtra,
  ): Promise<void> {
    const missingScopes = await this.missing(scopes, context, extra);
    if (missingScopes.length) {
      throw new McpFnError(
        DATAFN_INSUFFICIENT_SCOPE,
        `Tool ${toolName} needs scopes the session was not granted: ${missingScopes.join(", ")}`,
        { requiredScopes: [...scopes], missingScopes },
      );
    }
  }

  /**
   * Returns the definition with its handler (and task creation) checking the
   * scopes before any other work, and records the tool as gated.
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
    const needed = Object.freeze([...scopes]);
    const invalidArguments = fields.handleInvalidArguments;
    const gated = {
      ...fields,
      // Arguments are validated before the handler runs: check scopes first
      // there too, so an out-of-scope call never learns more than
      // insufficient_scope. Without a host handler, fail as McpFn does.
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
    const taskHandler = fields.taskHandler as McpFnToolDefinition<TContext>["taskHandler"];
    if (taskHandler && typeof taskHandler === "object") {
      const createTask = taskHandler.createTask;
      if (typeof createTask !== "function") {
        throw new McpFnValidationError(`Tool ${name} taskHandler.createTask must be a function`);
      }
      gated.taskHandler = {
        createTask: async (args, context, extra) => {
          await this.assert(name, needed, context, extra);
          return createTask.call(taskHandler, args, context, extra);
        },
      };
    }
    return gated;
  }

  /** Records a tool as gated once the registry accepted it. */
  record(toolName: string, scopes: readonly string[]): void {
    this.needed.set(toolName, Object.freeze([...scopes]));
  }
}
