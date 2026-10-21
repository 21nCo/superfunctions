import { realpath } from "node:fs/promises";
import path from "node:path";

import { defaultStateDir, validateDevFnConfig, type DevFnConfig } from "@devfn/config";
import { FilePortRegistry } from "@devfn/ports";
import type { ProxyRoute } from "@devfn/proxy";
import {
  markOwnerBinding, publishTunnelRoutes, readOwnerBindings, readTunnelBindings, resolveTunnelBinding, TunnelError, tunnelStatus, withdrawTunnelRoutes,
  type TunnelBinding, type TunnelServiceOptions, type TunnelWithdrawal,
} from "@devfn/proxy/tunnel";

import { domainAliases, resolveInstanceIdentity } from "./identity.js";
import { createPlan } from "./planner.js";
import { DevFnError, type LifecyclePlan, type RoutingIdentity } from "./types.js";

/** Provider, origin and readiness substitutes for the tunnel service; production uses the defaults. */
export type TunnelOverrides = Pick<TunnelServiceOptions, "provider" | "originCa" | "probeOrigin" | "readyTimeoutMs" | "originPort" | "ownerMayRun">;

/** Whether a lifecycle may still run by its registry evidence, so a new connector may route its published names again. */
export const lifecycleOwnerMayRun = (stateDir: string) => async (ownerId: string): Promise<boolean> => await new FilePortRegistry(path.join(stateDir, "registry.json")).instanceMayRun(ownerId);

export interface PublicSelection { binding: TunnelBinding; routes: Array<Omit<ProxyRoute, "updatedAt">>; urls: Record<string, string> }

/** The profile's public tunnel request; selecting it grants nothing without --allow-public. */
export function profileTunnel(config: DevFnConfig, plan: LifecyclePlan): { binding: string; routes: string[] } | undefined {
  return config.profiles[plan.profile]?.tunnel;
}

/**
 * The selected public origin routes and their deterministic URLs. Each public
 * hostname is `<host>-<worktree>-<suffix>.<binding domain>`: one label under
 * the binding's public domain, derived from the worktree identity alone, so
 * it is known before startup and never collides with another worktree.
 */
export async function selectedPublicRoutes(config: DevFnConfig, plan: LifecyclePlan, identity: RoutingIdentity, ports: Readonly<Record<string, number>>, stateDir: string): Promise<PublicSelection | undefined> {
  const tunnel = profileTunnel(config, plan);
  if (!tunnel || !plan.proxy) return undefined;
  const binding = await resolveTunnelBinding(stateDir, tunnel.binding, config.project.id, identity.repositoryIdentity).catch((error: unknown) => {
    throw new DevFnError("DEVFN_RUNTIME_INVALID", error instanceof Error ? error.message : String(error));
  });
  const routes: PublicSelection["routes"] = [];
  const urls: Record<string, string> = {};
  for (const name of tunnel.routes) {
    const spec = config.hostnames![name];
    if (!plan.portNames.includes(spec.target) || !Number.isInteger(ports[spec.target])) throw new DevFnError("DEVFN_RUNTIME_INVALID", `Public route ${name} has no selected target port.`);
    let hostname: string;
    try { hostname = domainAliases(spec.host ?? name, binding.domain, identity)[0]; }
    catch (error) { throw new DevFnError("DEVFN_RUNTIME_INVALID", `Public route ${name}: ${error instanceof Error ? error.message : String(error)}`); }
    routes.push({ id: `${identity.instanceId}:public:${name}`, instanceId: identity.instanceId, hostname, targetHost: "127.0.0.1", targetPort: ports[spec.target],
      tls: "internal", exposure: "public", publicDomain: binding.domain,
      ...(spec.path ? { path: spec.path } : {}), ...(spec.match ? { match: spec.match } : {}), ...(spec.stripPrefix ? { stripPrefix: true } : {}) });
    urls[name] = `https://${hostname}${spec.path && spec.path !== "/" ? spec.path : ""}`;
  }
  return { binding, routes, urls };
}

/**
 * Deterministic public URLs of a profile before anything starts. This reads
 * the machine binding only: it does not need --allow-public because it
 * neither starts a connector nor calls the provider.
 */
export async function planPublicUrls(options: { config: DevFnConfig; root: string; profile?: string; stateDir?: string }): Promise<{ binding?: string; urls: Record<string, string> }> {
  validateDevFnConfig(options.config);
  const plan = createPlan(options.config, options.profile);
  const identity = await resolveInstanceIdentity(options.config.project.id, options.root);
  const stateDir = await realpath(options.stateDir ?? defaultStateDir()).catch(() => options.stateDir ?? defaultStateDir());
  const selection = await selectedPublicRoutes(options.config, plan, identity, Object.fromEntries(plan.portNames.map((name) => [name, 1])), stateDir);
  return selection ? { binding: selection.binding.name, urls: selection.urls } : { urls: {} };
}

/** Whether the binding's connector runs and still publishes every hostname of this owner's tunnel receipt. */
export async function publicUrlsLive(stateDir: string, ownerId: string, tunnel: { binding: string; hostnames: string[] }): Promise<boolean> {
  const binding = (await readTunnelBindings(stateDir)).find((item) => item.name === tunnel.binding);
  const status = binding ? await tunnelStatus({ stateDir, binding }) : undefined;
  return status?.connector === "running" && tunnel.hostnames.every((hostname) => status.hostnames.some((item) => item.hostname === hostname && item.ownerId === ownerId));
}

/**
 * Publish the selection for this owner after withdrawing it from every other
 * binding, so a profile that changes binding leaves nothing on the old one.
 */
export async function publishLifecycleTunnel(stateDir: string, ownerId: string, selection: PublicSelection, overrides: TunnelOverrides = {}): Promise<string[]> {
  await withdrawLifecycleTunnel(stateDir, ownerId, overrides, selection.binding.name);
  const hostnames = [...new Set(selection.routes.map((route) => route.hostname))];
  return (await publishTunnelRoutes({ ownerMayRun: lifecycleOwnerMayRun(stateDir), ...overrides, stateDir, binding: selection.binding }, ownerId, hostnames)).map((item) => item.hostname);
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
