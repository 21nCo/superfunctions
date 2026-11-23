import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import {
  StreamableHTTPClientTransport,
  type StreamableHTTPClientTransportOptions,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import { customTarget } from "./custom-target.js";
import { loadStdioTarget } from "./load-stdio-target.mjs";
import {
  stdioTargetDescriptor,
  type McpFnStdioTargetOptions as StdioTargetOptions,
} from "./stdio-options.js";
import type { McpFnTarget, McpFnTargetDescriptor } from "./types.js";

export { customTarget } from "./custom-target.js";
/** @deprecated Import `McpFnStdioTargetOptions` from `@mcpfn/client/stdio`; removed in 0.2.0. */
export type McpFnStdioTargetOptions = StdioTargetOptions;

export interface McpFnStreamableHttpTargetOptions
  extends Omit<StreamableHTTPClientTransportOptions, "authProvider"> {
  authProvider?: OAuthClientProvider;
}

interface StateValidatingOAuthProvider extends OAuthClientProvider {
  validateAuthorizationState?(state: string | undefined): void | Promise<void>;
  invalidatePendingAuthorization?(): void | Promise<void>;
}

export function transportTarget(
  transport: Transport,
  descriptor?: McpFnTargetDescriptor,
): McpFnTarget {
  const targetDescriptor = descriptor ?? { kind: "custom" };
  let opened = false;
  return customTarget({
    kind: targetDescriptor.kind,
    descriptor: targetDescriptor,
    open: () => {
      if (opened) throw new Error("A one-shot McpFn transport target cannot be reopened");
      opened = true;
      return { transport, close: () => transport.close() };
    },
  });
}

/**
 * @deprecated Import `stdioTarget` from `@mcpfn/client/stdio`. This main-entry
 * compatibility export is removed in `@mcpfn/client` 0.2.0. It loads the stdio
 * transport only when the target opens, and only where the `node` condition
 * resolves `#stdio-target`; elsewhere (Cloudflare Workers, browsers) opening it
 * fails with `MCPFN_TARGET_OPEN_FAILED` instead of bundling `child_process`.
 */
export function stdioTarget(options: StdioTargetOptions): McpFnTarget {
  return customTarget({
    kind: "stdio",
    descriptor: stdioTargetDescriptor(options),
    open: async (context) => {
      // An already-cancelled open never starts the import. Otherwise settle as
      // soon as the connect is aborted (for example by close()), so a pending
      // import never holds the client in the closing state.
      if (context.signal?.aborted) throw abortReason(context.signal);
      const stdio = await untilAborted(loadStdioTarget(), context.signal);
      // The import can resolve just before an abort that lands ahead of this
      // continuation: a cancelled open still never spawns the server.
      if (context.signal?.aborted) throw abortReason(context.signal);
      return stdio.stdioTarget(options).open(context);
    },
  });
}

// The import's own outcome stays observed after an abort wins the race, so a
// late loader rejection is never reported as unhandled.
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("McpFn stdio target open was aborted");
}

export function streamableHttpTarget(
  url: string | URL,
  options: McpFnStreamableHttpTargetOptions = {},
): McpFnTarget {
  const targetUrl = new URL(url.toString());
  const descriptorUrl = new URL(targetUrl.toString());
  descriptorUrl.search = "";
  descriptorUrl.hash = "";
  descriptorUrl.username = "";
  descriptorUrl.password = "";
  return customTarget({
    kind: "streamable-http",
    descriptor: { url: descriptorUrl.toString() },
    open: () => {
      const transport = new StreamableHTTPClientTransport(targetUrl, options);
      return {
        transport,
        finishAuthorization: async (authorizationCode, state) => {
          const provider = options.authProvider as StateValidatingOAuthProvider | undefined;
          try {
            await provider?.validateAuthorizationState?.(state);
            await transport.finishAuth(authorizationCode);
          } catch (error) {
            await provider?.invalidatePendingAuthorization?.();
            throw error;
          }
        },
        terminateSession: () => transport.terminateSession(),
        close: () => transport.close(),
      };
    },
  });
}
