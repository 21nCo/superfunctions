import { McpError, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export function jsonSafe(value: unknown): unknown {
  const ancestors: object[] = [];
  try {
    const serialized = JSON.stringify(
      value,
      function (this: unknown, _key, entry: unknown) {
        if (typeof entry === "bigint") return entry.toString();
        if (entry && typeof entry === "object") {
          while (ancestors.length && ancestors.at(-1) !== this) ancestors.pop();
          if (ancestors.includes(entry)) return "[Circular]";
          ancestors.push(entry);
        }
        return entry;
      },
    );
    return serialized === undefined
      ? String(value)
      : (JSON.parse(serialized) as unknown);
  } catch {
    return "[Unserializable]";
  }
}

export class McpFnError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "McpFnError";
    this.code = code;
    this.details = details;
  }
}

export class McpFnValidationError extends McpFnError {
  constructor(message: string, details?: unknown) {
    super("MCPFN_INVALID_ARGUMENTS", message, details);
    this.name = "McpFnValidationError";
  }
}

export class McpFnOutputValidationError extends McpFnError {
  constructor(message: string, details?: unknown) {
    super("MCPFN_INVALID_OUTPUT", message, details);
    this.name = "McpFnOutputValidationError";
  }
}

export class McpFnClientProfileError extends McpFnError {
  constructor(code: string, message: string, details?: unknown) {
    super(code, message, details);
    this.name = "McpFnClientProfileError";
  }
}

export interface McpFnErrorResultOptions {
  includeStructuredContent?: boolean;
  /**
   * Return the code, message and details of any thrown value. By default only
   * `McpFnError`, `McpError` and thrown plain `{ code, message }` objects keep
   * them; any other error becomes a generic `MCPFN_TOOL_ERROR` so database,
   * filesystem or upstream error text does not reach the client and the model.
   */
  verbatim?: boolean;
  /** Correlation ID returned in `details.errorId` when an error is replaced. */
  errorId?: string;
}

/**
 * An SDK McpError, including one built from another copy of the SDK (this
 * package bundles its own, so instanceof alone misses an application's).
 */
export function isMcpErrorLike(error: unknown): error is Error & { code: number } {
  return error instanceof McpError ||
    (error instanceof Error && error.name === "McpError" && typeof (error as { code?: unknown }).code === "number");
}

/**
 * Whether this thrown value's own message reaches the client. Tool results
 * also keep thrown plain `{ code, message }` objects; protocol handlers keep
 * only McpFnError and McpError.
 */
export function isMcpFnClientSafeError(error: unknown, options: { plainObjects?: boolean } = {}): boolean {
  return error instanceof McpFnError || isMcpErrorLike(error) ||
    (options.plainObjects !== false && isCodedPlainObject(error));
}

function isCodedPlainObject(error: unknown): error is { code: string; message: string } {
  if (!error || typeof error !== "object" || error instanceof Error) return false;
  const prototype = Object.getPrototypeOf(error);
  return (prototype === Object.prototype || prototype === null) &&
    "code" in error && typeof error.code === "string" &&
    "message" in error && typeof error.message === "string";
}

function ownDetails(error: object): unknown {
  return "details" in error ? error.details : "metadata" in error ? error.metadata : undefined;
}

function verbatimError(error: unknown): { code: string; message: string; details?: unknown } {
  if (error instanceof McpFnError) return { code: error.code, message: error.message, details: error.details };
  if (
    error && typeof error === "object" &&
    "code" in error && typeof error.code === "string" &&
    "message" in error && typeof error.message === "string"
  ) {
    return { code: error.code, message: error.message, details: ownDetails(error) };
  }
  return {
    code: "MCPFN_TOOL_ERROR",
    message: error instanceof Error ? error.message : String(error),
  };
}

export function errorResult(
  error: unknown,
  options: McpFnErrorResultOptions = {},
): CallToolResult {
  const normalized = options.verbatim || isMcpFnClientSafeError(error)
    ? verbatimError(error)
    : {
        code: "MCPFN_TOOL_ERROR",
        message: "The tool failed",
        ...(options.errorId ? { details: { errorId: options.errorId } } : {}),
      };
  const structuredContent = jsonSafe({
    ok: false,
    error: Object.fromEntries(
      Object.entries(normalized).filter(([, value]) => value !== undefined),
    ),
  }) as { ok: false; error: Record<string, unknown> };
  return {
    content: [
      { type: "text", text: JSON.stringify(structuredContent, null, 2) },
    ],
    ...(options.includeStructuredContent === false
      ? {}
      : { structuredContent }),
    isError: true,
  };
}
