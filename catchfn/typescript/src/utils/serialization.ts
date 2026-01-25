/**
 * Error and data serialization utilities
 */

/**
 * Serialize an Error object
 */
export function serializeError(error: Error): Record<string, any> {
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    ...Object.getOwnPropertyNames(error).reduce(
      (acc, key) => {
        if (key !== "name" && key !== "message" && key !== "stack") {
          acc[key] = (error as any)[key];
        }
        return acc;
      },
      {} as Record<string, any>
    ),
  };
}

/**
 * Safely serialize any value, handling circular references
 */
export function safeSerialize(value: any, maxDepth: number = 10): any {
  const seen = new WeakSet();

  function serialize(val: any, depth: number): any {
    if (depth > maxDepth) {
      return "[Max Depth Reached]";
    }

    if (val === null) return null;
    if (val === undefined) return undefined;
    if (typeof val === "string") return val;
    if (typeof val === "number") return val;
    if (typeof val === "boolean") return val;
    if (typeof val === "function") return "[Function]";
    if (typeof val === "symbol") return val.toString();

    if (val instanceof Error) {
      return serializeError(val);
    }

    if (val instanceof Date) {
      return val.toISOString();
    }

    if (val instanceof RegExp) {
      return val.toString();
    }

    if (typeof val === "object") {
      if (seen.has(val)) {
        return "[Circular Reference]";
      }

      seen.add(val);

      if (Array.isArray(val)) {
        return val.map((item) => serialize(item, depth + 1));
      }

      const result: Record<string, any> = {};
      for (const key in val) {
        if (Object.prototype.hasOwnProperty.call(val, key)) {
          result[key] = serialize(val[key], depth + 1);
        }
      }
      return result;
    }

    return String(val);
  }

  return serialize(value, 0);
}

/**
 * Estimate the size of a serialized object in bytes
 */
export function estimateSize(obj: any): number {
  try {
    const str = JSON.stringify(safeSerialize(obj));
    return new Blob([str]).size;
  } catch {
    return 0;
  }
}

/**
 * Truncate a string to a maximum length
 */
export function truncateString(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.substring(0, maxLength - 3) + "...";
}

/**
 * Trim an array to a maximum size
 */
export function trimArray<T>(arr: T[], maxSize: number): T[] {
  if (arr.length <= maxSize) return arr;
  return arr.slice(-maxSize);
}
