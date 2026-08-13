import type {
  AdminCapabilityManifest,
  AdminOperationContext,
  AdminOperationDefinition,
  AdminOperationInput,
  AdminOperationOutput,
  AdminOperationResult,
  AdminResult,
} from "./types.js";
import type { AdminAuditEvent } from "./audit.js";

export interface AdminClientOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
  context?: Partial<Pick<AdminOperationContext, "idempotencyKey" | "confirmationToken">>;
}

export interface AdminClientRequestOptions {
  signal?: AbortSignal;
  headers?: HeadersInit;
  idempotencyKey?: string;
  confirmationToken?: string;
}

export interface AdminSearchOptions extends AdminClientRequestOptions {
  limit?: number;
  cursor?: string;
}

export interface AdminOverviewView {
  metrics: readonly Record<string, unknown>[];
  alerts: readonly Record<string, unknown>[];
  activity: readonly Record<string, unknown>[];
  health: readonly Record<string, unknown>[];
  session?: Readonly<Record<string, unknown>>;
  context?: Readonly<Record<string, unknown>>;
}

export interface AdminSearchResultItem {
  id: string;
  title: string;
  description?: string;
  moduleId: string;
  resource?: string;
  href: string;
  status?: string;
  updatedAt?: string;
}

export interface AdminSearchView {
  results: readonly AdminSearchResultItem[];
  total?: number;
  nextCursor?: string;
}

export interface AdminAuditView {
  events: readonly AdminAuditEvent[];
  total?: number;
  nextCursor?: string;
}

export interface AdminSettingsView {
  deploymentMode: string;
  configurationSource: string;
  tenantHierarchy: readonly string[];
  policies: readonly Record<string, unknown>[];
  retention: readonly Record<string, unknown>[];
  enabledModules: readonly string[];
}

export interface AdminMcpToolView {
  name: string;
  description: string;
  moduleId?: string;
  mutation?: boolean;
  permission?: string;
  annotations?: Readonly<Record<string, unknown>>;
}

export interface AdminMcpView {
  enabled: boolean;
  serverName: string;
  transport: "McpFn";
  endpoint: string;
  tools: readonly AdminMcpToolView[];
  clients: readonly Record<string, unknown>[];
}

export interface AdminAuditListOptions extends AdminClientRequestOptions {
  limit?: number;
  cursor?: string;
  actor?: string;
  module?: string;
  outcome?: AdminAuditEvent["outcome"];
  query?: string;
}

export interface AdminConfirmationReceipt {
  token: string;
  expiresAt: string;
}

export class AdminClientError extends Error {
  readonly status: number;
  readonly response?: AdminResult;
  constructor(message: string, status: number, response?: AdminResult) {
    super(message);
    this.name = "AdminClientError";
    this.status = status;
    this.response = response;
  }
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function encodeQuery(input: unknown): string {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "";
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (value === undefined) continue;
    query.set(key, typeof value === "string" ? value : JSON.stringify(value));
  }
  const serialized = query.toString();
  return serialized ? `?${serialized}` : "";
}

export class AdminClient {
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  private readonly configuredHeaders?: AdminClientOptions["headers"];
  private readonly defaults: AdminClientOptions["context"];

  constructor(options: AdminClientOptions) {
    this.baseUrl = options.baseUrl;
    this.fetcher = options.fetch ?? globalThis.fetch;
    if (!this.fetcher) throw new Error("AdminClient requires a fetch implementation.");
    this.configuredHeaders = options.headers;
    this.defaults = options.context;
  }

  async registry(options?: AdminClientRequestOptions): Promise<AdminCapabilityManifest[]> {
    const response = await this.request<{ enabledModules: AdminCapabilityManifest[] }>("GET", "registry", undefined, options);
    return response.enabledModules;
  }

  async openApi(options?: AdminClientRequestOptions): Promise<Record<string, unknown>> {
    return this.request("GET", "openapi.json", undefined, options);
  }

  async overview(options?: AdminClientRequestOptions): Promise<AdminOverviewView> {
    return this.request("GET", "overview", undefined, options);
  }

  async search(query: string, options: AdminSearchOptions = {}): Promise<AdminSearchView> {
    const { limit, cursor, ...requestOptions } = options;
    return this.request("GET", "search", { q: query, limit, cursor }, requestOptions);
  }

  async audit(options: AdminAuditListOptions = {}): Promise<AdminAuditView> {
    const { limit, cursor, actor, module, outcome, query, ...requestOptions } = options;
    return this.request("GET", "audit", { limit, cursor, actor, module, outcome, q: query }, requestOptions);
  }

  async settings(options?: AdminClientRequestOptions): Promise<AdminSettingsView> {
    return this.request("GET", "settings", undefined, options);
  }

  async mcp(options?: AdminClientRequestOptions): Promise<AdminMcpView> {
    return this.request("GET", "mcp", undefined, options);
  }

  async issueConfirmation(operationId: string, input: unknown, options?: AdminClientRequestOptions): Promise<AdminConfirmationReceipt> {
    return this.request("POST", "confirmations", { operationId, input }, options);
  }

  async invoke<T = unknown>(
    moduleId: string,
    route: { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; path: string },
    input?: unknown,
    options?: AdminClientRequestOptions,
  ): Promise<AdminOperationResult<T>> {
    const path = `modules/${encodeURIComponent(moduleId)}${route.path.startsWith("/") ? route.path : `/${route.path}`}`;
    return this.request<AdminOperationResult<T>>(route.method, path, input, options, false);
  }

  async invokeOperation<T = unknown>(
    operationId: string,
    input?: unknown,
    options?: AdminClientRequestOptions,
  ): Promise<AdminOperationResult<T>> {
    return this.request<AdminOperationResult<T>>(
      "POST",
      `operations/${encodeURIComponent(operationId)}`,
      input ?? {},
      options,
      false,
    );
  }

  private async request<T>(
    method: string,
    path: string,
    input?: unknown,
    options: AdminClientRequestOptions = {},
    unwrap = true,
  ): Promise<T> {
    const configured = typeof this.configuredHeaders === "function" ? await this.configuredHeaders() : this.configuredHeaders;
    const headers = new Headers(configured);
    new Headers(options.headers).forEach((value, key) => headers.set(key, value));
    headers.set("accept", "application/json");
    const idempotencyKey = options.idempotencyKey ?? this.defaults?.idempotencyKey;
    const confirmationToken = options.confirmationToken ?? this.defaults?.confirmationToken;
    if (idempotencyKey) headers.set("idempotency-key", idempotencyKey);
    if (confirmationToken) headers.set("x-admin-confirmation", confirmationToken);
    const isQuery = method === "GET" || method === "DELETE";
    if (!isQuery && input !== undefined) headers.set("content-type", "application/json");
    const response = await this.fetcher(joinUrl(this.baseUrl, `${path}${isQuery ? encodeQuery(input) : ""}`), {
      method,
      headers,
      signal: options.signal,
      ...(isQuery || input === undefined ? {} : { body: JSON.stringify(input) }),
    });
    const payload = await response.json().catch(() => undefined) as T | AdminResult | undefined;
    if (!response.ok) {
      const result = payload && typeof payload === "object" && "ok" in payload ? payload as AdminResult : undefined;
      throw new AdminClientError(result && result.ok === false ? result.error.message : `Administration request failed with HTTP ${response.status}.`, response.status, result);
    }
    if (unwrap && payload && typeof payload === "object" && "ok" in payload && (payload as AdminResult).ok !== false) {
      return (payload as { data: T }).data;
    }
    return payload as T;
  }
}

export function createAdminClient(options: AdminClientOptions): AdminClient { return new AdminClient(options); }

type CapabilityOperation<TManifest extends AdminCapabilityManifest> = TManifest["operations"][number];
type CapabilityOperationId<TManifest extends AdminCapabilityManifest> = CapabilityOperation<TManifest>["id"];
type CapabilityOperationById<
  TManifest extends AdminCapabilityManifest,
  TId extends CapabilityOperationId<TManifest>,
> = Extract<CapabilityOperation<TManifest>, { id: TId }> extends never
  ? AdminOperationDefinition
  : Extract<CapabilityOperation<TManifest>, { id: TId }>;

export interface CapabilityAdminClient<TManifest extends AdminCapabilityManifest> {
  readonly manifest: TManifest;
  invoke<TId extends CapabilityOperationId<TManifest>>(
    operationId: TId,
    input: AdminOperationInput<CapabilityOperationById<TManifest, TId>>,
    options?: AdminClientRequestOptions,
  ): Promise<AdminOperationResult<AdminOperationOutput<CapabilityOperationById<TManifest, TId>>>>;
}

/** Creates a function-scoped SDK while preserving manifest operation inference. */
export function createCapabilityAdminClient<const TManifest extends AdminCapabilityManifest>(
  manifest: TManifest,
  client: AdminClient,
): CapabilityAdminClient<TManifest> {
  return {
    manifest,
    async invoke<TId extends CapabilityOperationId<TManifest>>(
      operationId: TId,
      input: AdminOperationInput<CapabilityOperationById<TManifest, TId>>,
      options?: AdminClientRequestOptions,
    ): Promise<AdminOperationResult<AdminOperationOutput<CapabilityOperationById<TManifest, TId>>>> {
      return client.invokeOperation<AdminOperationOutput<CapabilityOperationById<TManifest, TId>>>(
        operationId,
        input,
        options,
      );
    },
  };
}
