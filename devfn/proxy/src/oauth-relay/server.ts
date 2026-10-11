import type { IncomingMessage, ServerResponse } from "node:http";

import { consumeOAuthRelayCallback, OAuthRelayError, type RelayStateOptions } from "./state.js";

export interface OAuthRelayHandlerOptions extends RelayStateOptions {
  stateDir: string;
  /** The relay's public origin, as recorded in its service record. */
  origin: string;
}

const NO_STORE = { "cache-control": "no-store", pragma: "no-cache", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" };

function respond(response: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  response.writeHead(status, { ...NO_STORE, "content-type": "text/plain; charset=utf-8", ...headers });
  response.end(body);
}

/**
 * The relay's only endpoint: a provider callback on the registered redirect
 * URI. It never logs, never sets or forwards cookies, and redirects only to
 * the callback URL bound to the consumed state. The owner's own OAuth client
 * still validates state, nonce and PKCE and performs the token exchange.
 */
export function createOAuthRelayHandler(options: OAuthRelayHandlerOptions): (request: IncomingMessage, response: ServerResponse) => void {
  const scheme = new URL(options.origin).protocol;
  return (request, response) => {
    void (async () => {
      if (request.method !== "GET") { respond(response, 405, "DEVFN_OAUTH_RELAY_REJECTED: method\n", { allow: "GET" }); return; }
      const target = request.url ?? "";
      const separator = target.indexOf("?");
      const host = request.headers.host;
      if (!target.startsWith("/") || separator < 0 || typeof host !== "string") { respond(response, 400, "DEVFN_OAUTH_RELAY_REJECTED: malformed\n"); return; }
      try {
        const { location } = await consumeOAuthRelayCallback(options.stateDir, {
          origin: options.origin, requestOrigin: `${scheme}//${host.toLowerCase()}`,
          requestPath: target.slice(0, separator), rawQuery: target.slice(separator + 1),
        }, options);
        response.writeHead(303, { ...NO_STORE, location });
        response.end();
      } catch (error) {
        if (!(error instanceof OAuthRelayError)) { respond(response, 500, "DEVFN_OAUTH_RELAY_FAILED\n"); return; }
        const status = error.code !== "DEVFN_OAUTH_RELAY_REJECTED" ? 503 : error.reason === "malformed" ? 400 : error.reason === "wrong-origin" ? 421 : 403;
        respond(response, status, `${error.code}${error.reason ? `: ${error.reason}` : ""}\n`);
      }
    })().catch(() => { if (!response.headersSent) respond(response, 500, "DEVFN_OAUTH_RELAY_FAILED\n"); else response.destroy(); });
  };
}
