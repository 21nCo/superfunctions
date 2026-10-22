import { realpath } from "node:fs/promises";
import path from "node:path";

import { defaultStateDir, validateDevFnConfig, type DevFnConfig } from "@devfn/config";
import { FilePortRegistry } from "@devfn/ports";
import type { ProxyRoute } from "@devfn/proxy";
import {
  markOwnerBinding, publishTunnelRoutes, readOwnerBindings, readTunnelBindings, resolveTunnelBinding, TunnelError, tunnelStatus, urlTiming, withdrawTunnelRoutes,
  type TunnelBinding, type TunnelServiceOptions, type TunnelWithdrawal, type UrlTiming,
} from "@devfn/proxy/tunnel";

import { domainAliases, resolveInstanceIdentity } from "./identity.js";
import { createPlan } from "./planner.js";
import { DevFnError, type LifecyclePlan, type RoutingIdentity } from "./types.js";

/** Provider, origin and readiness substitutes for the tunnel service; production uses the defaults. */
export type TunnelOverrides = Pick<TunnelServiceOptions, "provider" | "originCa" | "probeOrigin" | "readyTimeoutMs" | "originPort" | "ownerMayRun">;

/** Whether a lifecycle may still run by its registry evidence, so a new connector may route its published names again. */
export const lifecycleOwnerMayRun = (stateDir: string) => async (ownerId: string): Promise<boolean> => await new FilePortRegistry(path.join(stateDir, "registry.json")).instanceMayRun(ownerId);

/**
 * The selected public origin routes. With pre-start URL timing, urls holds
 * every route's deterministic public URL; with post-start timing it is
 * empty and postStart names the routes whose URLs the provider assigns
 * once the connector runs.
 */
export interface PublicSelection {
  binding: TunnelBinding; timing: UrlTiming; routes: Array<Omit<ProxyRoute, "updatedAt">>;
  /** The origin hostname of each selected route. */
  hostnames: Record<string, string>;
  urls: Record<string, string>; postStart: string[];
}

/** The profile's public tunnel request; selecting it grants nothing without --allow-public. */
export function profileTunnel(config: DevFnConfig, plan: LifecyclePlan): { binding: string; routes: string[]; ephemeral?: boolean } | undefined {
  return config.profiles[plan.profile]?.tunnel;
}

const routePath = (config: DevFnConfig, name: string): string => {
  const spec = config.hostnames![name];
  return spec.path && spec.path !== "/" ? spec.path : "";
};

/**
 * The selected public origin routes and their URLs. Each origin hostname is
 * `<host>-<worktree>-<suffix>.<binding domain>`: one label under the
 * binding's domain, derived from the worktree identity alone, so it is
 * known before startup and never collides with another worktree. It is the
 * public hostname, except for ephemeral endpoints, whose public URLs the
 * provider assigns after start; a profile must select those explicitly.
 */
export async function selectedPublicRoutes(config: DevFnConfig, plan: LifecyclePlan, identity: RoutingIdentity, ports: Readonly<Record<string, number>>, stateDir: string): Promise<PublicSelection | undefined> {
  const tunnel = profileTunnel(config, plan);
  if (!tunnel || !plan.proxy) return undefined;
  const binding = await resolveTunnelBinding(stateDir, tunnel.binding, config.project.id, identity.repositoryIdentity).catch((error: unknown) => {
    throw new DevFnError("DEVFN_RUNTIME_INVALID", error instanceof Error ? error.message : String(error));
  });
  const timing = urlTiming(binding);
  if (timing === "post-start" && tunnel.ephemeral !== true) {
    throw new DevFnError("DEVFN_RUNTIME_INVALID", `Tunnel binding ${binding.name} assigns public URLs only after its connector starts (ephemeral endpoints); select it explicitly with profiles.${plan.profile}.tunnel.ephemeral: true.`);
  }
  if (timing === "pre-start" && tunnel.ephemeral === true) {
    throw new DevFnError("DEVFN_RUNTIME_INVALID", `profiles.${plan.profile}.tunnel.ephemeral selects post-start public URLs, but tunnel binding ${binding.name} has deterministic URLs; remove it.`);
  }
  const routes: PublicSelection["routes"] = [];
  const urls: Record<string, string> = {};
  const hostnames: Record<string, string> = {};
  for (const name of tunnel.routes) {
    const spec = config.hostnames![name];
    if (!plan.portNames.includes(spec.target) || !Number.isInteger(ports[spec.target])) throw new DevFnError("DEVFN_RUNTIME_INVALID", `Public route ${name} has no selected target port.`);
    let hostname: string;
    try { hostname = domainAliases(spec.host ?? name, binding.domain, identity)[0]; }
    catch (error) { throw new DevFnError("DEVFN_RUNTIME_INVALID", `Public route ${name}: ${error instanceof Error ? error.message : String(error)}`); }
    routes.push({ id: `${identity.instanceId}:public:${name}`, instanceId: identity.instanceId, hostname, targetHost: "127.0.0.1", targetPort: ports[spec.target],
      tls: "internal", exposure: "public", publicDomain: binding.domain,
      ...(spec.path ? { path: spec.path } : {}), ...(spec.match ? { match: spec.match } : {}), ...(spec.stripPrefix ? { stripPrefix: true } : {}) });
    hostnames[name] = hostname;
    if (timing === "pre-start") urls[name] = `https://${hostname}${routePath(config, name)}`;
  }
  return { binding, timing, routes, hostnames, urls, postStart: timing === "post-start" ? [...tunnel.routes] : [] };
}

/**
 * The public URL template inputs of a profile: deterministic URLs, generated
 * as DEVFN_PUBLIC_URL_<ROUTE> before anything starts, and the routes whose
 * URLs only exist after start, whose references are rejected before any
 * mutation. A profile without a tunnel has neither.
 */
export async function publicTemplateInputs(config: DevFnConfig, plan: LifecyclePlan, identity: RoutingIdentity, stateDir: string): Promise<{ publicUrls?: Record<string, string>; postStartPublicRoutes?: string[] }> {
  if (!profileTunnel(config, plan)) return {};
  const selection = await selectedPublicRoutes(config, plan, identity, Object.fromEntries(plan.portNames.map((name) => [name, 1])), stateDir);
  return selection ? { publicUrls: selection.urls, postStartPublicRoutes: selection.postStart } : {};
}

/** Each selected route's public URL once published: its deterministic URL, or the one the provider assigned to its hostname. */
export function publishedPublicUrls(config: DevFnConfig, selection: PublicSelection, assigned: Readonly<Record<string, string>>): Record<string, string> {
  if (selection.timing === "pre-start") return { ...selection.urls };
  const urls: Record<string, string> = {};
  for (const [name, hostname] of Object.entries(selection.hostnames)) {
    const url = assigned[hostname];
    if (!url) throw new DevFnError("DEVFN_RUNTIME_INVALID", `The tunnel connector reported no public URL for route ${name}.`);
    urls[name] = `${url}${routePath(config, name)}`;
  }
  return urls;
}

/**
 * Deterministic public URLs of a profile before anything starts, and the
 * routes whose URLs are assigned only after start. This reads the machine
 * binding only: it does not need --allow-public because it neither starts a
 * connector nor calls the provider.
 */
export async function planPublicUrls(options: { config: DevFnConfig; root: string; profile?: string; stateDir?: string }): Promise<{ binding?: string; timing?: UrlTiming; urls: Record<string, string>; assignedAfterStart?: string[] }> {
  validateDevFnConfig(options.config);
  const plan = createPlan(options.config, options.profile);
  const identity = await resolveInstanceIdentity(options.config.project.id, options.root);
  const stateDir = await realpath(options.stateDir ?? defaultStateDir()).catch(() => options.stateDir ?? defaultStateDir());
  const selection = await selectedPublicRoutes(options.config, plan, identity, Object.fromEntries(plan.portNames.map((name) => [name, 1])), stateDir);
  if (!selection) return { urls: {} };
  return { binding: selection.binding.name, timing: selection.timing, urls: selection.urls, ...(selection.postStart.length ? { assignedAfterStart: selection.postStart } : {}) };
}

/** Whether every hostname of this owner's tunnel receipt is still published for it and routed by the binding's running connector. */
export async function publicUrlsLive(stateDir: string, ownerId: string, tunnel: { binding: string; hostnames: string[] }): Promise<boolean> {
  const binding = (await readTunnelBindings(stateDir)).find((item) => item.name === tunnel.binding);
  const status = binding ? await tunnelStatus({ stateDir, binding }) : undefined;
  return status?.connector === "running" && tunnel.hostnames.every((hostname) =>
    status.routed.includes(hostname) && status.hostnames.some((item) => item.hostname === hostname && item.ownerId === ownerId));
}

/**
 * Publish the selection for this owner after withdrawing it from every other
 * binding, so a profile that changes binding leaves nothing on the old one.
 * Returns the published hostnames, their public URLs by route and what the
 * old bindings still journal.
 */
export async function publishLifecycleTunnel(stateDir: string, ownerId: string, selection: PublicSelection, config: DevFnConfig, overrides: TunnelOverrides = {}): Promise<{ hostnames: string[]; urls: Record<string, string>; outstanding: string[] }> {
  const { outstanding } = await withdrawLifecycleTunnel(stateDir, ownerId, overrides, selection.binding.name);
  const hostnames = [...new Set(selection.routes.map((route) => route.hostname))];
  const published = await publishTunnelRoutes({ ownerMayRun: lifecycleOwnerMayRun(stateDir), ...overrides, stateDir, binding: selection.binding }, ownerId, hostnames);
  const assigned = selection.timing === "post-start" ? (await tunnelStatus({ stateDir, binding: selection.binding })).urls : {};
  return { hostnames: published.map((item) => item.hostname), urls: publishedPublicUrls(config, selection, assigned), outstanding };
}

/**
 * Withdraw every public hostname this owner publishes on any binding but
 * except. Only the bindings its publish-intent marker names are read, so a
 * lifecycle that never published reads no tunnel state at all, while one
 * that may have published fails closed on unreadable state. Each binding is
 * attempted; failures, meaning public reachability may not have ended, are
 * reported together. Returns the withdrawn hostnames and what is still
 * journaled for retry although reachability ended.
 */
export async function withdrawLifecycleTunnel(stateDir: string, ownerId: string, overrides: TunnelOverrides = {}, except?: string): Promise<TunnelWithdrawal> {
  const names = (await readOwnerBindings(stateDir, ownerId)).filter((name) => name !== except);
  const result: TunnelWithdrawal = { withdrawn: [], outstanding: [] };
  if (!names.length) return result;
  const bindings = await readTunnelBindings(stateDir);
  const failures: string[] = [];
  for (const name of names) {
    try {
      const binding = bindings.find((item) => item.name === name);
      // Unregistration is refused while a binding records anything, so an unregistered binding holds nothing of this owner.
      if (!binding) { await markOwnerBinding(stateDir, ownerId, name, false); continue; }
      const { withdrawn, outstanding } = await withdrawTunnelRoutes({ ...overrides, stateDir, binding }, ownerId);
      result.withdrawn.push(...withdrawn);
      result.outstanding.push(...outstanding.map((item) => `${name}: ${item}`));
    } catch (error) { failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  if (failures.length) throw new TunnelError("DEVFN_TUNNEL_UNAVAILABLE", `Public tunnel routes could not be fully withdrawn: ${failures.join(" ")}`);
  return result;
}
