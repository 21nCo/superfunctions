import type { DatafnSchema } from "@datafn/core";
import type { DatafnExecutor } from "@datafn/server";
import type {
  McpFnRegistry,
  McpFnRequestExtra,
  McpFnToolDefinition,
  McpFnToolVisibilityInput,
} from "@mcpfn/core";

export interface DatafnReadToolOptions {
  name?: string;
  description?: string;
}

export interface DatafnListToolOptions extends DatafnReadToolOptions {
  filterFields?: string[];
  sortFields?: string[];
  defaultLimit?: number;
  maxLimit?: number;
}

export interface DatafnWriteToolOptions {
  name?: string;
  description?: string;
  fields: string[];
}

/**
 * Scopes a session must hold to see and run a resource's tools. The host
 * defines the scope strings (for example `memotron:read`); the adapter only
 * matches them against the session's granted scopes.
 */
export interface DatafnResourceScopes {
  /** Needed by the list and get tools. */
  read?: string[];
  /** Needed by the create, update and delete tools. */
  write?: string[];
}

export interface DatafnResourceExposure {
  /** Fields returned by list/get. Explicit projection prevents schema expansion from leaking fields. */
  fields: string[];
  /**
   * Scopes the resource's read and write tools need. Required for every
   * enabled operation when `sessionScopes` is set, and refused without it.
   */
  scopes?: DatafnResourceScopes;
  /** List and get default to enabled for an explicitly listed resource. */
  list?: boolean | DatafnListToolOptions;
  get?: boolean | DatafnReadToolOptions;
  /** Mutations are always disabled unless configured with an explicit field allowlist. */
  create?: false | DatafnWriteToolOptions;
  update?: false | DatafnWriteToolOptions;
  delete?: boolean | Omit<DatafnWriteToolOptions, "fields">;
}

export interface CreateDatafnMcpRegistryOptions<TMcpContext, TDatafnContext> {
  /** @deprecated The executor's normalized schema is authoritative. */
  schema?: DatafnSchema;
  executor: DatafnExecutor<TDatafnContext>;
  expose: Record<string, DatafnResourceExposure>;
  /** Resolve trusted DataFn context from server-derived MCP context. */
  context: (context: TMcpContext) => TDatafnContext | Promise<TDatafnContext>;
  /**
   * Client ID used with DataFn idempotency records, which are keyed by
   * namespace, client ID and the model-supplied mutationId. Use the function
   * form and return a per-credential value: with one fixed string, two users
   * in a namespace share idempotency records, so one can receive the other's
   * cached mutation result. A string is accepted for read-only exposure, and
   * with mutations only when allowSharedClientId is true.
   */
  clientId: string | ((context: TMcpContext) => string | Promise<string>);
  /** Accept a fixed string clientId when mutation tools are exposed. */
  allowSharedClientId?: boolean;
  registry?: McpFnRegistry<TMcpContext>;
  toolPrefix?: string;
  /**
   * The scopes the session was granted, from the host's own authentication.
   * A needed `<owner>:<action>` scope is granted by the same string, by
   * `<owner>:*` or by `*`. A value that is not an array grants nothing, and
   * entries that are not strings are ignored.
   */
  sessionScopes?: (
    context: TMcpContext,
    extra: McpFnRequestExtra,
  ) => readonly string[] | Promise<readonly string[]>;
}

export interface DatafnMcpToolOptions {
  /** Scopes the session needs to see and run the tool; needs `sessionScopes`. */
  scopes?: string[];
}

export interface DatafnMcpAdapter<TMcpContext> {
  /** Holds the generated tools and any host tools registered beside them. */
  registry: McpFnRegistry<TMcpContext>;
  /**
   * Pass as `toolVisibility` to `createMcpFnServer`. On `tools/list` it hides
   * a scope-gated tool the session cannot use; on `tools/call` it lets the
   * tool through so its handler answers `insufficient_scope`. Tools the
   * adapter does not gate are always visible, so a host hook can be combined
   * with it.
   */
  toolVisibility(input: McpFnToolVisibilityInput<TMcpContext>): Promise<boolean>;
  /**
   * Registers a host domain tool beside the generated ones. With `scopes`, the
   * tool is listed and run under the same scope rules as the generated tools.
   */
  registerTool(
    definition: McpFnToolDefinition<TMcpContext>,
    options?: DatafnMcpToolOptions,
  ): DatafnMcpAdapter<TMcpContext>;
  /** The scopes a gated tool needs, or undefined when the adapter does not gate it. */
  requiredScopes(toolName: string): readonly string[] | undefined;
}
