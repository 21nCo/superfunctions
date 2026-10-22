/**
 * Structured logging with redaction: no raw document bodies, no asset bytes, no auth secrets.
 * OBS-001: logs contain action metadata only.
 */

export interface LogMutationInput {
  action: string;
  dataset?: string;
  docId?: string;
  /** Must NOT be logged (redacted). */
  body?: unknown;
}

export interface LogAuthInput {
  action: string;
  subject?: string;
  /** Must NOT be logged (redacted). */
  token?: string;
  /** Must NOT be logged (redacted). */
  password?: string;
}

export type LogSink = (level: string, message: string, meta: Record<string, unknown>) => void;

/** Never log these keys; omit entirely. */
const SENSITIVE_KEYS = new Set(["body", "token", "password", "secret", "authorization"]);

function safeMeta(input: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v !== undefined && !SENSITIVE_KEYS.has(k)) out[k] = v;
  }
  return out;
}

export interface CmsfnLoggerConfig {
  sink?: LogSink;
}

const defaultSink: LogSink = (level, message, meta) => {
  const line = JSON.stringify({ level, message, ...meta });
  if (level === "error") {
    console.error(line);
  } else {
    console.log(line);
  }
};

/**
 * Create a logger that never logs body, token, password, or other sensitive fields.
 */
export function createLogger(config: CmsfnLoggerConfig = {}): {
  logMutation: (input: LogMutationInput) => void;
  logAuth: (input: LogAuthInput) => void;
} {
  const sink = config.sink ?? defaultSink;

  return {
    logMutation(input: LogMutationInput) {
      const meta = safeMeta(input);
      sink("info", "mutation", meta);
    },

    logAuth(input: LogAuthInput) {
      const meta = safeMeta(input);
      sink("info", "auth", meta);
    },
  };
}
