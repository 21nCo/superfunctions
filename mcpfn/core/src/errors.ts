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

/** Whether errorResult() returns this thrown value's own message to the client. */
export function isMcpFnClientSafeError(error: unknown): boolean {
  return error instanceof McpFnError || error instanceof McpError || isCodedPlainObject(error);
}

function isCodedPlainObject(error: unknown): error is { code: string; message: string } {
  if (!error || typeof error !== "object" || error instanceof Error) return false;
  const prototype = Object.getPrototypeOf(error);
  return (prototype === Object.prototype || prototype === null) &&
    "code" in error && typeof error.code === "string" &&
    "message" in error && typeof error.message === "string";
}

function verbatimError(error: unknown): { code: string; message: string; details?: unknown } {
  return error instanceof McpFnError
    ? { code: error.code, message: error.message, details: error.details }
    : error instanceof Error &&
        "code" in error &&
        typeof error.code === "string"
      ? {
          code: error.code,
          message: error.message,
          details:
            "details" in error
              ? error.details
              : "metadata" in error
                ? error.metadata
                : undefined,
        }
      : error &&
          typeof error === "object" &&
          "code" in error &&
          typeof error.code === "string" &&
          "message" in error &&
          typeof error.message === "string"
        ? {
            code: error.code,
            message: error.message,
            details:
              "details" in error
                ? error.details
                : "metadata" in error
                  ? error.metadata
                  : undefined,
          }
        : {
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
