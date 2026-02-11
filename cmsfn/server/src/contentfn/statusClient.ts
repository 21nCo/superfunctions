/**
 * ContentFn status client: fetches /contentfn/status and verifies required capabilities.
 * Used by CmsFn status endpoint to fail with CONTENTFN_UNAVAILABLE when unreachable or missing caps.
 */

/** Required capabilities when preview is disabled. */
const REQUIRED_CAPABILITIES = [
  "content.schema",
  "content.docs",
  "content.assets",
] as const;

/** Additional capability when preview is enabled. */
const REALTIME_CAPABILITY = "content.realtime";

export interface ContentfnStatusResult {
  serverTime: string;
  capabilities: string[];
}

/**
 * Deterministically parse ContentFn status response.
 * Expects envelope shape: { ok: true, result: { serverTime, capabilities, limits? } }.
 */
function parseContentfnStatusResponse(body: string): ContentfnStatusResult | null {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const obj = data as Record<string, unknown>;
  if (obj.ok !== true || typeof obj.result !== "object" || obj.result === null)
    return null;
  const result = obj.result as Record<string, unknown>;
  const serverTime = result.serverTime;
  const capabilities = result.capabilities;
  if (typeof serverTime !== "string") return null;
  if (!Array.isArray(capabilities) || !capabilities.every((c) => typeof c === "string"))
    return null;
  return { serverTime, capabilities: capabilities as string[] };
}

/**
 * Fetch ContentFn status and verify required capabilities.
 * Returns the parsed result when reachable and capabilities are satisfied;
 * returns null when unreachable, parse error, or missing required capability.
 *
 * @param baseUrl - ContentFn base URL (e.g. "http://localhost:3000")
 * @param requireRealtime - When true, "content.realtime" must be present (preview enabled).
 */
export async function fetchContentfnStatus(
  baseUrl: string,
  requireRealtime: boolean
): Promise<ContentfnStatusResult | null> {
  const normalizedBase = baseUrl.replace(/\/+$/, "");
  const url = `${normalizedBase}/contentfn/status`;

  let response: Response;
  try {
    response = await fetch(url, { method: "GET" });
  } catch {
    return null;
  }

  if (!response.ok) return null;

  const text = await response.text();
  const parsed = parseContentfnStatusResponse(text);
  if (!parsed) return null;

  const required = [...REQUIRED_CAPABILITIES];
  if (requireRealtime) required.push(REALTIME_CAPABILITY);

  for (const cap of required) {
    if (!parsed.capabilities.includes(cap)) return null;
  }

  return parsed;
}
