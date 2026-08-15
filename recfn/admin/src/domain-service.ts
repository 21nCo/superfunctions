import type { Bot, Recording } from "@recfn/core";
import { createRecFnServer } from "@recfn/server";
import { AdminError, type AdminOperationContext } from "@superfunctions/admin";
import type {
  RecFnAdminService,
  RecFnAdminWebhook,
  RecFnDomainAdminServiceOptions,
} from "./types.js";

const INTERNAL_KEY = "recfn-admin-internal";

type RecFnEnvelope<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; details?: Record<string, unknown> } };

function translateError(status: number, code: string, message: string, details?: Record<string, unknown>): never {
  const kind = status === 400 ? "invalid_argument"
    : status === 401 ? "unauthenticated"
      : status === 403 ? "forbidden"
        : status === 404 ? "not_found"
          : status === 409 ? "conflict"
            : status === 422 ? "precondition_failed"
              : status === 429 || status >= 500 ? "dependency_unavailable"
                : "internal";
  throw new AdminError(kind, message, {
    details: { domainCode: code, ...(details ?? {}) },
    retryable: status === 429 || status >= 500,
  });
}

function encode(value: string): string {
  return encodeURIComponent(value);
}

function safeBot(bot: Bot): Bot {
  return {
    id: bot.id,
    namespace: "[REDACTED]",
    meetingUrl: "[REDACTED]",
    platform: bot.platform,
    status: bot.status,
    config: bot.config,
    ...(bot.errorMessage ? { errorMessage: "[REDACTED]" } : {}),
    createdAt: bot.createdAt,
    updatedAt: bot.updatedAt,
  };
}

function safeRecording(recording: Recording): Recording {
  return {
    id: recording.id,
    botId: recording.botId,
    format: recording.format,
    duration: recording.duration,
    storageRef: "[REDACTED]",
    size: recording.size,
    createdAt: recording.createdAt,
  };
}

/**
 * Binds the function-owned admin contract to RecFn's public authenticated
 * router. Namespace is derived exclusively from the active admin scope; no
 * operation accepts a tenant selector.
 */
export function createRecFnDomainAdminService(
  options: RecFnDomainAdminServiceOptions,
): RecFnAdminService {
  if (!options.projectId.trim()) {
    throw new AdminError("invalid_argument", "RecFn admin binding requires a projectId.");
  }

  const assertScope = (context: AdminOperationContext): string => {
    if (!context.scope.projectId || context.scope.projectId !== options.projectId) {
      throw new AdminError("forbidden", "The active project cannot access this RecFn runtime.");
    }
    const namespace = context.scope.namespace?.trim();
    if (!namespace) {
      throw new AdminError("precondition_failed", "RecFn administration requires a scoped namespace.");
    }
    return namespace;
  };

  const request = async <T>(
    context: AdminOperationContext,
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<T> => {
    const namespace = assertScope(context);
    const server = createRecFnServer({
      ...options.server,
      rateLimit: false,
      calendarRuntime: options.server.calendarRuntime
        ? { ...options.server.calendarRuntime, enabled: false }
        : undefined,
      validateApiKey: (key) => key === INTERNAL_KEY ? { namespace, apiKey: key } : null,
    });
    const response = await server.router.handle(new Request(`http://recfn.local${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${INTERNAL_KEY}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: context.signal,
    }));
    let envelope: RecFnEnvelope<T>;
    try {
      envelope = await response.json() as RecFnEnvelope<T>;
    } catch (error) {
      throw new AdminError("internal", "RecFn returned a non-JSON administration response.", { cause: error });
    }
    if (!envelope.ok) {
      return translateError(response.status, envelope.error.code, envelope.error.message, envelope.error.details);
    }
    return envelope.data;
  };

  return {
    async listBots(input, context) {
      const query = new URLSearchParams();
      if (input.limit !== undefined) query.set("limit", String(input.limit));
      if (input.cursor) query.set("cursor", input.cursor);
      if (input.status) query.set("status", input.status);
      if (input.platform) query.set("platform", input.platform);
      const data = await request<{ bots: Bot[]; nextCursor: string | null }>(context, "GET", `/api/v1/bots${query.size ? `?${query}` : ""}`);
      return { items: data.bots.map(safeBot), nextCursor: data.nextCursor };
    },

    async getBot(input, context) {
      const data = await request<Bot>(context, "GET", `/api/v1/bots/${encode(input.botId)}`);
      return { item: safeBot(data) };
    },

    leaveBot(input, context) {
      return request(context, "POST", `/api/v1/bots/${encode(input.botId)}/leave`);
    },

    deleteBot(input, context) {
      return request(context, "DELETE", `/api/v1/bots/${encode(input.botId)}`);
    },

    async listRecordings(input, context) {
      const data = await request<{ recordings: Recording[] }>(context, "GET", `/api/v1/bots/${encode(input.botId)}/recordings`);
      return { items: data.recordings.map(safeRecording), nextCursor: null };
    },

    async getRecording(input, context) {
      const data = await request<Recording>(context, "GET", `/api/v1/recordings/${encode(input.recordingId)}`);
      return { item: safeRecording(data) };
    },

    async getTranscript(input, context) {
      const item = await request<Awaited<ReturnType<RecFnAdminService["getTranscript"]>>["item"]>(context, "GET", `/api/v1/recordings/${encode(input.recordingId)}/transcript`);
      return { item };
    },

    async listParticipants(input, context) {
      const data = await request<{ participants: Awaited<ReturnType<RecFnAdminService["listParticipants"]>>["items"] }>(context, "GET", `/api/v1/bots/${encode(input.botId)}/participants`);
      return { items: data.participants, nextCursor: null };
    },

    async listChat(input, context) {
      const data = await request<{ messages: Awaited<ReturnType<RecFnAdminService["listChat"]>>["items"] }>(context, "GET", `/api/v1/bots/${encode(input.botId)}/chat`);
      return { items: data.messages, nextCursor: null };
    },

    async getMetadata(input, context) {
      const item = await request<Awaited<ReturnType<RecFnAdminService["getMetadata"]>>["item"]>(context, "GET", `/api/v1/bots/${encode(input.botId)}/metadata`);
      return { item };
    },

    async getAnalytics(input, context) {
      const item = await request<Awaited<ReturnType<RecFnAdminService["getAnalytics"]>>["item"]>(context, "GET", `/api/v1/recordings/${encode(input.recordingId)}/analytics`);
      return { item };
    },

    async listWebhooks(_input, context) {
      const data = await request<{ webhooks: RecFnAdminWebhook[] }>(context, "GET", "/api/v1/webhooks");
      return { items: data.webhooks, nextCursor: null };
    },

    async createWebhook(input, context) {
      const item = await request<RecFnAdminWebhook>(context, "POST", "/api/v1/webhooks", input);
      return { item };
    },

    deleteWebhook(input, context) {
      return request(context, "DELETE", `/api/v1/webhooks/${encode(input.webhookId)}`);
    },
  };
}
