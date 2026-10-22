/** Test HTTP data remains unknown until each accessed shape is checked. */
export async function readResponse(response: Response): Promise<unknown> {
  const body: unknown = await response.json();
  if (body === null || typeof body !== "object" || Array.isArray(body) || !("ok" in body) || typeof body.ok !== "boolean") {
    throw new Error("Expected an envelope with a boolean ok field");
  }
  return body;
}
export function field(value: unknown, path: string): unknown {
  for (const key of path.split(".")) {
    if (value === undefined || value === null) return undefined;
    if (key === "length" && (typeof value === "string" || Array.isArray(value))) return value.length;
    if (typeof value !== "object") throw new Error(`Expected an object at ${path}`);
    value = Reflect.get(value, key);
  }
  return value;
}
export function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Expected an array");
  return value;
}
export function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected a string");
  return value;
}
