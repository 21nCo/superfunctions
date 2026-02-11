export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const levelWeight: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 50,
};

const getEnv = (): Record<string, string | undefined> => {
  const env = (globalThis as { process?: { env?: Record<string, string> } })
    ?.process?.env;
  return env ?? {};
};

const resolveLevel = (): LogLevel => {
  const env = getEnv();
  const raw = env.CHARTFN_LOG_LEVEL?.toLowerCase();
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error" || raw === "silent") {
    return raw;
  }
  if (env.NODE_ENV === "production") {
    return "warn";
  }
  return "debug";
};

const shouldLog = (level: LogLevel, target: LogLevel): boolean =>
  levelWeight[level] >= levelWeight[target];

const log = (level: LogLevel, message: string, meta?: Record<string, unknown>) => {
  const current = resolveLevel();
  if (!shouldLog(level, current)) {
    return;
  }

  const payload = meta ? { ...meta } : undefined;
  switch (level) {
    case "debug":
      console.debug(message, payload ?? "");
      break;
    case "info":
      console.info(message, payload ?? "");
      break;
    case "warn":
      console.warn(message, payload ?? "");
      break;
    case "error":
      console.error(message, payload ?? "");
      break;
    default:
      break;
  }
};

export const logger = {
  debug: (message: string, meta?: Record<string, unknown>) =>
    log("debug", message, meta),
  info: (message: string, meta?: Record<string, unknown>) =>
    log("info", message, meta),
  warn: (message: string, meta?: Record<string, unknown>) =>
    log("warn", message, meta),
  error: (message: string, meta?: Record<string, unknown>) =>
    log("error", message, meta),
};
