/**
 * Serialization utilities for FlowFn
 */

export interface SerializationOptions {
  pretty?: boolean;
  includeUndefined?: boolean;
  dateFormat?: "iso" | "timestamp";
}

/**
 * Serialize job data to JSON string
 */
export function serialize<T = any>(
  data: T,
  options: SerializationOptions = {},
): string {
  const { pretty = false, dateFormat = "iso" } = options;

  const replacer = (key: string, value: any) => {
    // Handle dates
    if (value instanceof Date) {
      return dateFormat === "timestamp" ? value.getTime() : value.toISOString();
    }

    // Handle undefined
    if (value === undefined && !options.includeUndefined) {
      return null;
    }

    // Handle functions (skip them)
    if (typeof value === "function") {
      return undefined;
    }

    // Handle BigInt
    if (typeof value === "bigint") {
      return value.toString();
    }

    return value;
  };

  return JSON.stringify(data, replacer, pretty ? 2 : undefined);
}

/**
 * Deserialize JSON string to object
 */
export function deserialize<T = any>(json: string): T {
  return JSON.parse(json, (key, value) => {
    // Try to parse ISO date strings
    if (typeof value === "string") {
      const isoDateRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z?$/;
      if (isoDateRegex.test(value)) {
        return new Date(value);
      }
    }
    return value;
  });
}

/**
 * Safely serialize data with circular reference handling
 */
export function serializeSafe<T = any>(
  data: T,
  options: SerializationOptions = {},
): string {
  const seen = new WeakSet();
  const { pretty = false } = options;

  const replacer = (key: string, value: any) => {
    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) {
        return "[Circular]";
      }
      seen.add(value);
    }

    // Handle dates
    if (value instanceof Date) {
      return value.toISOString();
    }

    // Handle functions
    if (typeof value === "function") {
      return "[Function]";
    }

    // Handle BigInt
    if (typeof value === "bigint") {
      return value.toString();
    }

    return value;
  };

  return JSON.stringify(data, replacer, pretty ? 2 : undefined);
}

/**
 * Clone an object using serialization
 */
export function cloneViaSerialization<T>(obj: T): T {
  return deserialize(serialize(obj));
}

/**
 * Serialize with compression (base64 encode)
 */
export function serializeCompressed<T = any>(data: T): string {
  const json = serialize(data);
  return Buffer.from(json).toString("base64");
}

/**
 * Deserialize compressed data
 */
export function deserializeCompressed<T = any>(compressed: string): T {
  const json = Buffer.from(compressed, "base64").toString("utf-8");
  return deserialize(json);
}

/**
 * Check if a value is serializable
 */
export function isSerializable(value: any): boolean {
  try {
    serialize(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get size of serialized data in bytes
 */
export function getSerializedSize(data: any): number {
  return Buffer.byteLength(serialize(data), "utf-8");
}
