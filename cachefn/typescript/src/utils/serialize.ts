/** Versioned, collision-free serialization of cache values. */
type Node = [string, ...unknown[]];
const FORMAT = "cachefn/1";
const hasOwn = (object: object, key: PropertyKey): boolean => Object.prototype.hasOwnProperty.call(object, key);

export function serialize(value: any): string {
  const active = new Set<object>();
  const encode = (item: any): Node => {
    if (item === null) return ["null"];
    switch (typeof item) {
      case "undefined": return ["undefined"];
      case "string": return ["string", item];
      case "boolean": return ["boolean", item];
      case "number": return ["number", Object.is(item, -0) ? "-0" : String(item)];
      case "bigint": return ["bigint", String(item)];
      case "function":
      case "symbol": throw new TypeError("Unsupported cache serialization value");
    }
    if (active.has(item)) throw new TypeError("Cannot serialize circular cache values");
    active.add(item);
    try {
      if (item instanceof Date) return ["date", String(item.getTime())];
      if (item instanceof RegExp) {
        if (!Number.isSafeInteger(item.lastIndex) || item.lastIndex < 0) {
          throw new TypeError("Cannot serialize a RegExp with an invalid lastIndex");
        }
        return ["regexp", item.source, item.flags, item.lastIndex];
      }
      if (item instanceof Map) return ["map", [...item].map(([k, v]) => [encode(k), encode(v)])];
      if (item instanceof Set) return ["set", [...item].map(encode)];
      if (Array.isArray(item)) {
        return ["array", Array.from({ length: item.length }, (_, i) =>
          hasOwn(item, i) ? encode(item[i]) : ["hole"])];
      }
      const proto = Object.getPrototypeOf(item);
      if (proto !== Object.prototype && proto !== null) {
        throw new TypeError("Unsupported cache serialization object type");
      }
      if (Object.getOwnPropertySymbols(item).some(symbol =>
        Object.prototype.propertyIsEnumerable.call(item, symbol))) {
        throw new TypeError("Cannot serialize symbol-keyed cache properties");
      }
      return [proto === null ? "dictionary" : "object", Object.keys(item).map(key => [key, encode(item[key])])];
    } finally {
      active.delete(item);
    }
  };
  return JSON.stringify({ format: FORMAT, value: encode(value) });
}

export function deserialize<T = any>(json: string): T {
  const parsed = JSON.parse(json);
  // Ordinary JSON remains readable. Reserved user properties are never revived.
  if (!parsed || parsed.format !== FORMAT || !hasOwn(parsed, "value")) return parsed;
  const invalid = (): never => { throw new TypeError("Invalid CacheFn serialization payload"); };
  const decode = (node: unknown): any => {
    if (!Array.isArray(node) || typeof node[0] !== "string") return invalid();
    const [tag, value] = node;
    switch (tag) {
      case "null": if (node.length === 1) return null; break;
      case "undefined": if (node.length === 1) return undefined; break;
      case "string": if (node.length === 2 && typeof value === "string") return value; break;
      case "boolean": if (node.length === 2 && typeof value === "boolean") return value; break;
      case "number":
      case "date":
        if (node.length !== 2 || typeof value !== "string" ||
            !/^(?:NaN|-?Infinity|-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)$/i.test(value)) break;
        return tag === "date" ? new Date(Number(value)) : Number(value);
      case "bigint":
        if (node.length === 2 && typeof value === "string" && /^-?\d+$/.test(value)) return BigInt(value);
        break;
      case "regexp": {
        if (node.length !== 4 || typeof value !== "string" || typeof node[2] !== "string" ||
            !Number.isSafeInteger(node[3]) || node[3] < 0) break;
        const expression = new RegExp(value, node[2]);
        expression.lastIndex = node[3];
        return expression;
      }
      case "array": {
        if (node.length !== 2 || !Array.isArray(value)) break;
        const result = new Array(value.length);
        value.forEach((entry, index) => {
          if (Array.isArray(entry) && entry.length === 1 && entry[0] === "hole") return;
          result[index] = decode(entry);
        });
        return result;
      }
      case "set":
        if (node.length === 2 && Array.isArray(value)) return new Set(value.map(decode));
        break;
      case "map":
      case "object":
      case "dictionary": {
        if (node.length !== 2 || !Array.isArray(value)) break;
        const result = tag === "map" ? new Map() : Object.create(tag === "dictionary" ? null : Object.prototype);
        for (const pair of value) {
          if (!Array.isArray(pair) || pair.length !== 2) return invalid();
          if (tag === "map") result.set(decode(pair[0]), decode(pair[1]));
          else {
            if (typeof pair[0] !== "string" || hasOwn(result, pair[0])) return invalid();
            Object.defineProperty(result, pair[0], { value: decode(pair[1]), enumerable: true, writable: true, configurable: true });
          }
        }
        return result;
      }
    }
    return invalid();
  };
  return decode(parsed.value);
}

/** Approximate UTF-16 payload size, with a cycle-safe fallback for memory-only values. */
export function estimateSize(value: any): number {
  try {
    return (typeof value === "string" ? value : serialize(value)).length * 2;
  } catch {
    const seen = new Set<object>();
    const measure = (item: any): number => {
      if (item === null || item === undefined) return 0;
      if (typeof item === "string") return item.length * 2;
      if (typeof item !== "object") return 8;
      if (seen.has(item)) return 0;
      seen.add(item);
      try {
        if (item instanceof Map) return [...item].reduce((n, [k, v]) => n + measure(k) + measure(v), 0);
        if (item instanceof Set) return [...item].reduce((n, v) => n + measure(v), 0);
        return Object.values(Object.getOwnPropertyDescriptors(item)).reduce((n, entry) =>
          n + ("value" in entry ? measure(entry.value) : 0), 0);
      } catch { return 0; }
    };
    return measure(value);
  }
}
