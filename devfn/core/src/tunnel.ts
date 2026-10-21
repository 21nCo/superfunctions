import { realpath } from "node:fs/promises";

import { defaultStateDir, validateDevFnConfig, type DevFnConfig } from "@devfn/config";
import type { ProxyRoute } from "@devfn/proxy";
import {
  publishTunnelRoutes, readTunnelBindings, readTunnelState, resolveTunnelBinding, TunnelError, tunnelOwnerBindings, tunnelStateNames, withdrawTunnelRoutes,
  type TunnelBinding, type TunnelServiceOptions,
} from "@devfn/proxy/tunnel";

import { domainAliases, resolveInstanceIdentity } from "./identity.js";
import { createPlan } from "./planner.js";
import { DevFnError, type LifecyclePlan, type RoutingIdentity } from "./types.js";

/** Provider, origin and readiness substitutes for the tunnel service; production uses the defaults. */
export type TunnelOverrides = Pick<TunnelServiceOptions, "provider" | "originCa" | "probeOrigin" | "readyTimeoutMs" | "originPort">;

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

/** The lifecycle a withdrawal is for; with a project, only bindings registered to it can hold the owner. */
export interface TunnelOwner { instanceId: string; projectId?: string }

/**
 * Publish the selection for this owner after withdrawing it from every other
 * binding, so a profile that changes binding leaves nothing on the old one.
 */
export async function publishLifecycleTunnel(stateDir: string, owner: TunnelOwner, selection: PublicSelection, overrides: TunnelOverrides = {}): Promise<string[]> {
  await withdrawLifecycleTunnel(stateDir, owner, overrides, selection.binding.name);
  const hostnames = [...new Set(selection.routes.map((route) => route.hostname))];
  return (await publishTunnelRoutes({ ...overrides, stateDir, binding: selection.binding }, owner.instanceId, hostnames)).map((item) => item.hostname);
}

/**
 * Withdraw every public hostname this owner publishes on any binding but
 * except. Owners are found from binding state, so a lifecycle that never
 * published reads nothing else; a binding whose state is unreadable fails
 * only the owners it may hold (any owner of its project while it is
 * registered). Each binding is attempted; failures are reported together.
 * Returns the withdrawn hostnames.
 */
export async function withdrawLifecycleTunnel(stateDir: string, owner: TunnelOwner, overrides: TunnelOverrides = {}, except?: string): Promise<string[]> {
  const { names, unreadable } = await tunnelOwnerBindings(stateDir, owner.instanceId);
  if (!names.length && !unreadable.length) return [];
  let registry: Promise<TunnelBinding[]> | undefined;
  const registered = async () => await (registry ??= readTunnelBindings(stateDir));
  const withdrawn: string[] = [];
  const failures: string[] = [];
  for (const name of unreadable.filter((item) => item !== except)) {
    const bindings = await registered().catch(() => undefined);
    const binding = bindings?.find((item) => item.name === name);
    if (bindings && (!binding || (owner.projectId !== undefined && binding.projectId !== owner.projectId))) continue;
    failures.push(`${name}: its tunnel state is unreadable.`);
  }
  for (const name of names.filter((item) => item !== except)) {
    try {
      const binding = (await registered()).find((item) => item.name === name);
      if (!binding) throw new TunnelError("DEVFN_TUNNEL_UNREGISTERED", "the binding is no longer registered.");
      withdrawn.push(...await withdrawTunnelRoutes({ ...overrides, stateDir, binding }, owner.instanceId));
    } catch (error) { failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  if (failures.length) throw new TunnelError("DEVFN_TUNNEL_UNAVAILABLE", `Public tunnel routes could not be fully withdrawn: ${failures.join(" ")}`);
  return withdrawn;
}

/** Lock-free: every owner a readable binding state records as publishing, or mid-transition. */
export async function publishedTunnelOwners(stateDir: string): Promise<string[]> {
  const owners = new Set<string>();
  for (const name of await tunnelStateNames(stateDir)) {
    const state = await readTunnelState(stateDir, name).catch(() => undefined);
    for (const item of state?.hostnames ?? []) owners.add(item.ownerId);
    if (state?.pending) owners.add(state.pending.ownerId);
  }
  return [...owners];
}
