import type { Route, RouteContext } from "@superfunctions/http";
import type {
  OAuthFlowCallbackInput,
  OAuthFlowCallbackResult,
  OAuthFlowDisconnectInput,
  OAuthFlowService,
  OAuthFlowStartInput
} from "@superfunctions/oauth-flow";

export interface OAuthConnectionRouteConfig {
  basePath: string;
  flowService: OAuthFlowService;
  resolveStartInput: (request: Request, context: RouteContext) => Promise<OAuthFlowStartInput> | OAuthFlowStartInput;
  resolveDisconnectInput?: (
    request: Request,
    context: RouteContext
  ) => Promise<Omit<OAuthFlowDisconnectInput, "providerId" | "requestId">> | Omit<OAuthFlowDisconnectInput, "providerId" | "requestId">;
  resolveCallbackInput?: (
    request: Request,
    context: RouteContext
  ) => Promise<Partial<Omit<OAuthFlowCallbackInput, "providerId" | "requestId">>> | Partial<Omit<OAuthFlowCallbackInput, "providerId" | "requestId">>;
  serializeCallbackResult?: (
    result: OAuthFlowCallbackResult,
    request: Request,
    context: RouteContext
  ) => Promise<unknown> | unknown;
  requestIdHeader?: string;
}

export function createOAuthConnectionRoutes(config: OAuthConnectionRouteConfig): Route[] {
  const requestIdHeader = (config.requestIdHeader ?? "x-request-id").toLowerCase();

  return [
    {
      method: "POST",
      path: joinPath(config.basePath, "start"),
      meta: { auth: { mode: "none" } },
      handler: async (request, context) => {
        const requestId = request.headers.get(requestIdHeader) ?? undefined;
        const input = await config.resolveStartInput(request, context);
        const result = await config.flowService.start({
          ...input,
          requestId
        });
        return Response.json(result);
      }
    },
    {
      method: "GET",
      path: joinPath(config.basePath, "callback/:provider"),
      meta: { auth: { mode: "none" } },
      handler: async (request, context) => {
        const requestId = request.headers.get(requestIdHeader) ?? undefined;
        const resolvedInput = (await config.resolveCallbackInput?.(request, context)) ?? {};
        const url = new URL(request.url);
        const callbackResult = await config.flowService.handleCallback({
          providerId: context.params.provider,
          code: asRequiredString(resolvedInput.code ?? url.searchParams.get("code"), "code"),
          state: asRequiredString(resolvedInput.state ?? url.searchParams.get("state"), "state"),
          redirectUri: asRequiredString(resolvedInput.redirectUri ?? url.searchParams.get("redirectUri"), "redirectUri"),
          requestId
        });

        const payload = config.serializeCallbackResult
          ? await config.serializeCallbackResult(callbackResult, request, context)
          : callbackResult;
        return Response.json(payload);
      }
    },
    {
      method: "POST",
      path: joinPath(config.basePath, "disconnect/:provider"),
      meta: { auth: { mode: "none" } },
      handler: async (request, context) => {
        const requestId = request.headers.get(requestIdHeader) ?? undefined;
        const input =
          (await config.resolveDisconnectInput?.(request, context)) ??
          (await parseDisconnectBody(request));

        const result = await config.flowService.disconnect({
          ...input,
          providerId: context.params.provider,
          requestId
        });
        return Response.json(result);
      }
    }
  ];
}

function joinPath(basePath: string, suffix: string): string {
  const normalizedBase = basePath.startsWith("/") ? basePath : `/${basePath}`;
  return `${normalizedBase.replace(/\/$/, "")}/${suffix.replace(/^\//, "")}`;
}

function asRequiredString(value: string | null | undefined, field: string): string {
  if (!value || value.length === 0) {
    throw new Error(`${field} is required`);
  }
  return value;
}

async function parseDisconnectBody(
  request: Request
): Promise<Omit<OAuthFlowDisconnectInput, "providerId" | "requestId">> {
  const body = (await request.json()) as {
    connectionId?: string;
    revokeRemote?: boolean;
    tokenTypeHint?: "access_token" | "refresh_token";
  };

  return {
    connectionId: asRequiredString(body.connectionId, "connectionId"),
    revokeRemote: body.revokeRemote,
    tokenTypeHint: body.tokenTypeHint
  };
}
