import path from "node:path";

// Kept in ports so both the domain registry and port-claim recovery can
// validate proxy state without importing the proxy package back into ports.
export interface PersistedProxyRoute {
  id: string; instanceId: string; hostname: string; targetHost: "127.0.0.1" | "::1";
  targetPort: number; tls: "off" | "internal" | "certificate"; updatedAt: string;
  path?: string; match?: "exact" | "prefix"; stripPrefix?: boolean;
  registeredDomain?: string; projectId?: string; repositoryIdentity?: string;
  certificateFile?: string; keyFile?: string; certificateDigest?: string;
  /** A route to a process group leader DevFn started outside a lifecycle; it is dropped once that whole group is verified gone. */
  serviceProcess?: { pid: number; birthSignature: string };
  /** A public-tunnel origin route, served only on the public origin listener. */
  exposure?: "public";
  /** The tunnel binding's public domain containing the hostname; required for public routes. */
  publicDomain?: string;
}

const hostnamePattern = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const routePathPattern = /^\/[A-Za-z0-9._~!$&'()+,;=:@/-]*$/;
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
// A birth signature in a format DevFn reads must be exactly the text its
// producer, processBirthSignature, renders: the sweep compares that text, so
// any other rendering of a live start time reads as a reused PID. One in no
// such format is never compared, so its route stays.
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** The UTC instant these calendar fields name, or undefined when they name no real date and time. */
function utcInstant(year: number, month: number, day: number, hours: number, minutes: number, seconds: number): Date | undefined {
  const date = new Date(0);
  date.setUTCFullYear(year, month, day);
  date.setUTCHours(hours, minutes, seconds, 0);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month && date.getUTCDate() === day &&
    date.getUTCHours() === hours && date.getUTCMinutes() === minutes && date.getUTCSeconds() === seconds ? date : undefined;
}
const canonicalBirthSignatures: Record<string, (text: string) => boolean> = {
  // The /proc start time in clock ticks, an unsigned 64-bit decimal.
  linux: (text) => /^(?:0|[1-9]\d{0,19})$/.test(text) && (text.length < 20 || text <= "18446744073709551615"),
  // ps lstart in the pinned C locale and UTC, "%a %b %e %H:%M:%S %Y", of a
  // time_t start, so never before the epoch.
  "darwin-utc": (text) => {
    const match = /^([A-Z][a-z]{2}) ([A-Z][a-z]{2}) ( [1-9]|[12]\d|3[01]) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(text);
    const date = match ? utcInstant(Number(match[7]), MONTHS.indexOf(match[2]), Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6])) : undefined;
    return date !== undefined && date.getTime() >= 0 && WEEKDAYS[date.getUTCDay()] === match![1];
  },
  // .NET's round-trip ("O") rendering of a UTC DateTime: seven fraction digits
  // and Z, in DateTime's years 0001 through 9999.
  win32: (text) => {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.\d{7}Z$/.exec(text);
    return match !== null && Number(match[1]) >= 1 &&
      utcInstant(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6])) !== undefined;
  },
};
// Node's process APIs take a 32-bit PID and probe a group as the negated PID,
// so a recorded PID beyond int32 can never be judged: it is malformed, never
// evidence that the recorded process exited.
const MAX_PID = 2 ** 31 - 1;
/** Whether a recorded PID is one Node's process APIs can judge: an integer in 1..2^31-1. */
export const isProcessId = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 1 && (value as number) <= MAX_PID;
export const canonicalBirthSignature = (signature: string): boolean => {
  const format = signature.includes(":") ? signature.slice(0, signature.indexOf(":")) : "";
  return !Object.hasOwn(canonicalBirthSignatures, format) || canonicalBirthSignatures[format](signature.slice(format.length + 1));
};

export function parsePersistedProxyRoutes(value: unknown): PersistedProxyRoute[] {
  if (!value || typeof value !== "object" || (value as { version?: unknown }).version !== 1 ||
    !Array.isArray((value as { routes?: unknown }).routes)) throw new Error("Invalid proxy route state.");
  const routes = (value as { routes: unknown[] }).routes;
  const ids = new Set<string>();
  const paths = new Set<string>();
  const hosts = new Map<string, { owner: string; tls: string; exposure: string }>();
  for (const value of routes) {
    if (!value || typeof value !== "object") throw new Error("Invalid proxy route.");
    const route = value as Record<string, unknown>;
    if (!nonempty(route.id) || !nonempty(route.instanceId) || !nonempty(route.hostname) ||
      route.hostname.length > 253 || !hostnamePattern.test(route.hostname) ||
      (route.targetHost !== "127.0.0.1" && route.targetHost !== "::1") ||
      !Number.isInteger(route.targetPort) || (route.targetPort as number) < 1 || (route.targetPort as number) > 65535 ||
      !["off", "internal", "certificate"].includes(route.tls as string) ||
      !nonempty(route.updatedAt)) throw new Error("Invalid proxy route.");
    const routePath = route.path ?? "/";
    const match = route.match ?? "prefix";
    if (typeof routePath !== "string" || !routePathPattern.test(routePath) || routePath.includes("//") ||
      routePath.split("/").some((part) => part === "." || part === "..") ||
      !["exact", "prefix"].includes(match as string) ||
      (route.stripPrefix !== undefined && typeof route.stripPrefix !== "boolean") ||
      (route.stripPrefix === true && (match !== "prefix" || routePath === "/"))) throw new Error("Invalid proxy path.");
    if (route.registeredDomain !== undefined &&
      (!nonempty(route.registeredDomain) || !hostnamePattern.test(route.registeredDomain) ||
        route.registeredDomain !== route.registeredDomain.toLowerCase() ||
        !(route.hostname.toLowerCase() === route.registeredDomain.toLowerCase() ||
          route.hostname.toLowerCase().endsWith(`.${route.registeredDomain.toLowerCase()}`)) ||
        !nonempty(route.projectId) || !nonempty(route.repositoryIdentity))) throw new Error("Invalid registered route.");
    if (route.exposure !== undefined || route.publicDomain !== undefined) {
      // Public origin routes are validated against their tunnel binding, never
      // as loopback-registered or certificate routes.
      if (route.exposure !== "public" || !nonempty(route.publicDomain) || !hostnamePattern.test(route.publicDomain) ||
        route.publicDomain !== route.publicDomain.toLowerCase() || route.publicDomain.endsWith(".localhost") ||
        !route.hostname.toLowerCase().endsWith(`.${route.publicDomain}`) || route.tls !== "internal" ||
        route.registeredDomain !== undefined || route.serviceProcess !== undefined) throw new Error("Invalid public route.");
    } else if (!route.hostname.toLowerCase().endsWith(".localhost") && route.registeredDomain === undefined) throw new Error("Unregistered route hostname.");
    if (route.tls === "certificate") {
      if (!nonempty(route.certificateFile) || !path.isAbsolute(route.certificateFile) ||
        !nonempty(route.keyFile) || !path.isAbsolute(route.keyFile)) throw new Error("Invalid certificate route.");
    } else if (route.certificateFile !== undefined || route.keyFile !== undefined || route.certificateDigest !== undefined) {
      throw new Error("Unexpected certificate route fields.");
    }
    if (route.certificateDigest !== undefined && (typeof route.certificateDigest !== "string" || !/^[a-f0-9]{64}$/.test(route.certificateDigest))) throw new Error("Invalid certificate digest.");
    const service = route.serviceProcess as { pid?: unknown; birthSignature?: unknown } | undefined;
    if (service !== undefined && (!service || typeof service !== "object" || !isProcessId(service.pid) ||
      !nonempty(service.birthSignature) || !canonicalBirthSignature(service.birthSignature))) throw new Error("Invalid route service process.");
    const hostname = route.hostname.toLowerCase();
    const host = hosts.get(hostname);
    const exposure = route.exposure === "public" ? "public" : "local";
    if (ids.has(route.id) || (host && (host.owner !== route.instanceId || host.tls !== route.tls || host.exposure !== exposure))) throw new Error("Conflicting proxy route.");
    ids.add(route.id);
    hosts.set(hostname, { owner: route.instanceId, tls: route.tls as string, exposure });
    const canonicalPath = match === "prefix" ? routePath.replace(/\/$/, "") || "/" : routePath;
    const key = `${hostname}\0${match}\0${canonicalPath.toLowerCase()}`;
    if (paths.has(key)) throw new Error("Ambiguous proxy route.");
    paths.add(key);
  }
  return routes as PersistedProxyRoute[];
}
