import type { DemoWorkspaceId } from "./identity.js";

const WORKSPACE_PREFIX = "workspace:";

type CrossWorkspaceErrorEnvelope = {
  ok: false;
  error: {
    code: "DEMO_CROSS_WORKSPACE_DENIED";
    message: "Cross-workspace sharing is not allowed";
    details: {
      fromWorkspaceId: DemoWorkspaceId;
      targetWorkspaceId: string;
      path: string;
    };
  };
};

type ValidationResult =
  | { ok: true }
  | { ok: false; error: CrossWorkspaceErrorEnvelope };

function parseWorkspaceQualifiedPrincipal(
  value: unknown,
): { targetWorkspaceId: string } | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed.startsWith(WORKSPACE_PREFIX)) {
    return null;
  }

  const remainder = trimmed.slice(WORKSPACE_PREFIX.length);
  const separatorIndex = remainder.indexOf(":");
  if (separatorIndex <= 0 || separatorIndex === remainder.length - 1) {
    return null;
  }

  return {
    targetWorkspaceId: remainder.slice(0, separatorIndex),
  };
}

function extractSharePrincipal(mutation: Record<string, unknown>): unknown {
  const shareWith = mutation.shareWith;
  if (typeof shareWith !== "object" || shareWith === null) {
    return undefined;
  }

  const candidate = shareWith as Record<string, unknown>;
  return candidate.principalId ?? candidate.userId;
}

function buildCrossWorkspaceError(input: {
  fromWorkspaceId: DemoWorkspaceId;
  targetWorkspaceId: string;
  path: string;
}): CrossWorkspaceErrorEnvelope {
  return {
    ok: false,
    error: {
      code: "DEMO_CROSS_WORKSPACE_DENIED",
      message: "Cross-workspace sharing is not allowed",
      details: {
        fromWorkspaceId: input.fromWorkspaceId,
        targetWorkspaceId: input.targetWorkspaceId,
        path: input.path,
      },
    },
  };
}

export function validateDemoCrossWorkspaceSharing(input: {
  workspaceId: DemoWorkspaceId;
  payload: unknown;
}): ValidationResult {
  const mutations = Array.isArray(input.payload) ? input.payload : [input.payload];

  for (let index = 0; index < mutations.length; index += 1) {
    const mutation = mutations[index];
    if (typeof mutation !== "object" || mutation === null) {
      continue;
    }

    const entry = mutation as Record<string, unknown>;
    const operation = entry.operation;
    if (operation !== "share" && operation !== "unshare") {
      continue;
    }

    const parsed = parseWorkspaceQualifiedPrincipal(extractSharePrincipal(entry));
    if (!parsed) {
      continue;
    }

    if (parsed.targetWorkspaceId !== input.workspaceId) {
      return {
        ok: false,
        error: buildCrossWorkspaceError({
          fromWorkspaceId: input.workspaceId,
          targetWorkspaceId: parsed.targetWorkspaceId,
          path: Array.isArray(input.payload)
            ? `$[${index}].shareWith.principalId`
            : "$.shareWith.principalId",
        }),
      };
    }
  }

  return { ok: true };
}
