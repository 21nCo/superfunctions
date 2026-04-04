import type { AuthRouteMeta, HttpRouteMeta, OpenApiRouteMeta, Route, RouteContext } from "@superfunctions/http";
import type {
  OAuthFlowCallbackInput,
  OAuthFlowCallbackResult,
  OAuthFlowDisconnectInput,
  OAuthFlowService,
  OAuthFlowStartInput
} from "@superfunctions/oauth-flow";

export type OAuthBrowserCallbackMode = "redirect" | "json";

export type OAuthBrowserRouteMetaOverrides = {
  start?: HttpRouteMeta;
  callback?: HttpRouteMeta;
  disconnect?: HttpRouteMeta;
};

export interface OAuthBrowserRouteConfig {
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
  callbackMode?: OAuthBrowserCallbackMode | ((
    result: OAuthFlowCallbackResult,
    request: Request,
    context: RouteContext
  ) => Promise<OAuthBrowserCallbackMode> | OAuthBrowserCallbackMode);
  getRedirectLocation?: (
    result: OAuthFlowCallbackResult,
    request: Request,
    context: RouteContext
  ) => Promise<string> | string;
  serializeCallbackResult?: (
    result: OAuthFlowCallbackResult,
    request: Request,
    context: RouteContext
  ) => Promise<unknown> | unknown;
  routeMeta?: OAuthBrowserRouteMetaOverrides;
  requestIdHeader?: string;
}

export function createOAuthBrowserRoutes(config: OAuthBrowserRouteConfig): Route[] {
  const requestIdHeader = (config.requestIdHeader ?? "x-request-id").toLowerCase();

  return [
    {
      method: "POST",
      path: joinPath(config.basePath, "start"),
      meta: resolveRouteMeta({ auth: { mode: "none" } }, config.routeMeta?.start),
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
      meta: resolveRouteMeta({ auth: { mode: "none" } }, config.routeMeta?.callback),
      handler: async (request, context) => {
        const requestId = request.headers.get(requestIdHeader) ?? undefined;
        const resolvedInput = (await config.resolveCallbackInput?.(request, context)) ?? {};
        const url = new URL(request.url);
        const callbackResult = await config.flowService.handleCallback({
          providerId: context.params.provider,
          code: asRequiredString(resolvedInput.code ?? url.searchParams.get("code"), "code"),
          state: asRequiredString(resolvedInput.state ?? url.searchParams.get("state"), "state"),
          redirectUri:
            resolvedInput.redirectUri ??
            url.searchParams.get("redirectUri") ??
            `${url.origin}${url.pathname}`,
          requestId
        });

        const mode = await resolveCallbackMode(config.callbackMode, callbackResult, request, context);
        if (mode === "redirect") {
          const location = await resolveRedirectLocation(config, callbackResult, request, context);
          return Response.redirect(location, 302);
        }

        const payload = config.serializeCallbackResult
          ? await config.serializeCallbackResult(callbackResult, request, context)
          : callbackResult;
        return Response.json(payload);
      }
    },
    {
      method: "POST",
      path: joinPath(config.basePath, "disconnect/:provider"),
      meta: resolveRouteMeta({ auth: { mode: "hybrid" } }, config.routeMeta?.disconnect),
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

function resolveRouteMeta(defaultMeta: HttpRouteMeta, overrideMeta: HttpRouteMeta | undefined): HttpRouteMeta {
  if (!overrideMeta) {
    return defaultMeta;
  }

  return {
    ...defaultMeta,
    ...overrideMeta,
    auth: mergeAuthMeta(defaultMeta.auth, overrideMeta.auth),
    openapi: mergeOpenApiMeta(defaultMeta.openapi, overrideMeta.openapi)
  };
}

function mergeAuthMeta(
  defaultMeta: AuthRouteMeta | undefined,
  overrideMeta: AuthRouteMeta | undefined
): AuthRouteMeta | undefined {
  if (!defaultMeta) {
    return overrideMeta ? { ...overrideMeta } : undefined;
  }

  if (!overrideMeta) {
    return { ...defaultMeta };
  }

  return {
    ...defaultMeta,
    ...overrideMeta
  };
}

function mergeOpenApiMeta(
  defaultMeta: OpenApiRouteMeta | undefined,
  overrideMeta: OpenApiRouteMeta | undefined
): OpenApiRouteMeta | undefined {
  if (!defaultMeta) {
    return overrideMeta ? { ...overrideMeta } : undefined;
  }

  if (!overrideMeta) {
    return { ...defaultMeta };
  }

  return {
    ...defaultMeta,
    ...overrideMeta
  };
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

async function resolveCallbackMode(
  mode: OAuthBrowserRouteConfig["callbackMode"],
  result: OAuthFlowCallbackResult,
  request: Request,
  context: RouteContext
): Promise<OAuthBrowserCallbackMode> {
  if (!mode) {
    return "json";
  }

  if (typeof mode === "function") {
    return mode(result, request, context);
  }

  return mode;
}

async function resolveRedirectLocation(
  config: OAuthBrowserRouteConfig,
  result: OAuthFlowCallbackResult,
  request: Request,
  context: RouteContext
): Promise<string> {
  if (config.getRedirectLocation) {
    return config.getRedirectLocation(result, request, context);
  }

  if (result.subject.kind === "browser-auth" && result.subject.returnTo) {
    return result.subject.returnTo;
  }

  return "/";
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
