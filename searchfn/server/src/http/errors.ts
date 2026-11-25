/**
 * Canonical error/envelope utilities for @searchfn/server
 */
import { SearchAdapterError } from "@searchfn/adapter-contracts";

export type SearchFnErrorCode =
  | "DFQL_INVALID"
  | "LIMIT_EXCEEDED"
  | "DFQL_ABORTED"
  | "DFQL_UNSUPPORTED"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "FORBIDDEN"
  | "INTERNAL";

export interface SearchFnError {
  code: SearchFnErrorCode;
  message: string;
  details?: unknown;
}

export interface SearchFnEnvelope<T = unknown> {
  ok: boolean;
  result?: T;
  error?: SearchFnError;
}

export function okEnvelope<T>(result: T): SearchFnEnvelope<T> {
  return { ok: true, result };
}

export function errorEnvelope(
  code: SearchFnErrorCode,
  message: string,
  details?: unknown,
): SearchFnEnvelope<never> {
  return {
    ok: false,
    error: { code, message, ...(details !== undefined ? { details } : {}) },
  };
}

const STATUS_MAP: Record<SearchFnErrorCode, number> = {
  DFQL_INVALID: 400,
  LIMIT_EXCEEDED: 400,
  DFQL_ABORTED: 499,
  DFQL_UNSUPPORTED: 400,
  UNSUPPORTED_MEDIA_TYPE: 415,
  FORBIDDEN: 403,
  INTERNAL: 500,
};

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export function okResponse<T>(result: T): Response {
  return jsonResponse(okEnvelope(result));
}

export function errorResponse(
  code: SearchFnErrorCode,
  message: string,
  details?: unknown,
): Response {
  return jsonResponse(errorEnvelope(code, message, details), STATUS_MAP[code]);
}

function isSearchFnErrorCode(code: string): code is SearchFnErrorCode {
  return Object.prototype.hasOwnProperty.call(STATUS_MAP, code);
}

export function mapAdapterErrorToResponse(
  error: unknown,
  fallbackMessage: string,
): Response {
  if (error instanceof SearchAdapterError && isSearchFnErrorCode(error.code)) {
    return errorResponse(error.code, error.message);
  }
  return errorResponse("INTERNAL", fallbackMessage);
}

const mediaTypeWord = "[!#$%&'*+.^_`|~0-9a-z-]+";
const mediaTypeQuotedString = String.raw`"(?:[\t\x20-\x21\x23-\x5b\x5d-\x7e\x80-\xff]|\\[\t\x20-\x7e\x80-\xff])*"`;
// RFC 9110 §5.6.6 allows a semicolon followed by an empty parameter.
const jsonContentType = new RegExp(
  String.raw`^application/json(?:[ \t]*;(?:[ \t]*${mediaTypeWord}=(?:${mediaTypeWord}|${mediaTypeQuotedString}))?)*[ \t]*$`,
  "i",
);

/**
 * Safely parse JSON body from a Request.
 */
export async function parseJsonBody(
  req: Request,
  maxPayloadBytes?: number,
): Promise<{ ok: true; data: unknown } | { ok: false; response: Response }> {
  if (!jsonContentType.test(req.headers.get("content-type") ?? "")) {
    return {
      ok: false,
      response: errorResponse("UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json"),
    };
  }

  try {
    const lengthHeader = req.headers.get("content-length");
    if (maxPayloadBytes && lengthHeader) {
      const declaredLength = Number(lengthHeader);
      if (Number.isFinite(declaredLength) && declaredLength > maxPayloadBytes) {
        return {
          ok: false,
          response: errorResponse("LIMIT_EXCEEDED", "Request payload exceeds maximum size", {
            path: "$",
            max: maxPayloadBytes,
          }),
        };
      }
    }

    const body = req.body;
    let text = "";
    if (!body) {
      text = await req.text();
    } else {
      const decoder = new TextDecoder();
      const reader = body.getReader();
      let totalBytes = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
          totalBytes += value.byteLength;
          if (maxPayloadBytes && totalBytes > maxPayloadBytes) {
            return {
              ok: false,
              response: errorResponse("LIMIT_EXCEEDED", "Request payload exceeds maximum size", {
                path: "$",
                max: maxPayloadBytes,
              }),
            };
          }
          text += decoder.decode(value, { stream: true });
        }
      }
      text += decoder.decode();
    }

    if (!text || text.trim() === "") {
      return {
        ok: false,
        response: errorResponse("DFQL_INVALID", "Invalid JSON", { path: "$" }),
      };
    }
    if (maxPayloadBytes) {
      const payloadBytes = new TextEncoder().encode(text).byteLength;
      if (payloadBytes > maxPayloadBytes) {
        return {
          ok: false,
          response: errorResponse("LIMIT_EXCEEDED", "Request payload exceeds maximum size", {
            path: "$",
            max: maxPayloadBytes,
          }),
        };
      }
    }
    return { ok: true, data: JSON.parse(text) };
  } catch {
    return {
      ok: false,
      response: errorResponse("DFQL_INVALID", "Invalid JSON", { path: "$" }),
    };
  }
}
