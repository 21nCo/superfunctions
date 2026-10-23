import { v4 as uuidv4, v5 as uuidv5, v1 as uuidv1 } from "uuid";
import { createHash, randomBytes } from "crypto";

/**
 * ID generation strategies
 */
export type IdStrategy =
  | "uuid-v4"
  | "uuid-v5"
  | "uuid-v1"
  | "nanoid"
  | "incremental"
  | "custom";

export interface IdGeneratorOptions {
  strategy?: IdStrategy;
  namespace?: string; // For UUID v5
  prefix?: string;
  customGenerator?: () => string;
}

/**
 * Generate a unique identifier based on the specified strategy
 */
export function generateId(options: IdGeneratorOptions = {}): string {
  const {
    strategy = "uuid-v4",
    namespace,
    prefix = "",
    customGenerator,
  } = options;

  let id: string;

  switch (strategy) {
    case "uuid-v4":
      id = uuidv4();
      break;

    case "uuid-v5":
      if (!namespace) {
        throw new Error("UUID v5 requires a namespace");
      }
      const name = `${Date.now()}-${randomBytes(8).toString("hex")}`;
      id = uuidv5(name, namespace);
      break;

    case "uuid-v1":
      id = uuidv1();
      break;

    case "nanoid":
      // Simple nanoid-like implementation
      id = randomBytes(16).toString("base64url");
      break;

    case "incremental":
      // Simple timestamp-based incremental ID
      id = `${Date.now()}-${randomBytes(4).toString("hex")}`;
      break;

    case "custom":
      if (!customGenerator) {
        throw new Error("Custom strategy requires customGenerator function");
      }
      id = customGenerator();
      break;

    default:
      id = uuidv4();
  }

  return prefix ? `${prefix}${id}` : id;
}

/**
 * Generate a job ID with optional prefix
 */
export function generateJobId(prefix?: string): string {
  return generateId({ prefix: prefix || "job_" });
}

/**
 * Generate a workflow execution ID
 */
export function generateExecutionId(prefix?: string): string {
  return generateId({ prefix: prefix || "exec_" });
}

/**
 * Generate a message ID for streams
 */
export function generateMessageId(prefix?: string): string {
  return generateId({ prefix: prefix || "msg_" });
}

/**
 * Generate a deterministic ID based on content (useful for idempotency)
 */
export function generateDeterministicId(
  content: string | object,
  prefix?: string
): string {
  const hash = createHash("sha256");
  const data = typeof content === "string" ? content : JSON.stringify(content);
  hash.update(data);
  const id = hash.digest("hex").slice(0, 32);
  return prefix ? `${prefix}${id}` : id;
}
