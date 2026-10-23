/**
 * Serialization utilities
 */

/**
 * Serialize a value to JSON with support for special types
 */
export function serialize(value: any): string {
  return JSON.stringify(value, (key, val) => {
    if (val instanceof Date) {
      return { __type: "Date", value: val.toISOString() };
    }
    if (val instanceof RegExp) {
      return { __type: "RegExp", value: val.toString() };
    }
    if (val === undefined) {
      return { __type: "undefined" };
    }
    return val;
  });
}

/**
 * Deserialize a JSON string with support for special types
 */
export function deserialize<T = any>(json: string): T {
  return JSON.parse(json, (key, val) => {
    if (val && typeof val === "object" && "__type" in val) {
      if (val.__type === "Date") {
        return new Date(val.value);
      }
      if (val.__type === "RegExp") {
        const match = val.value.match(/^\/(.*)\/([gimsuy]*)$/);
        return match ? new RegExp(match[1], match[2]) : val.value;
      }
      if (val.__type === "undefined") {
        return undefined;
      }
    }
    return val;
  });
}

/**
 * Estimate the size of a value in bytes
 */
export function estimateSize(value: any): number {
  const str = typeof value === "string" ? value : serialize(value);
  return str.length * 2; // Approximate size in bytes (UTF-16)
}
