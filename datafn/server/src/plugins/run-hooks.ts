/**
 * Plugin hook runner for server-side plugins
 * Delegates to shared @datafn/core hook runner with env: "server"
 */

import type { DatafnPlugin, DatafnHookContext } from "@datafn/core";
import { runBeforeHook, runAfterHook } from "@datafn/core";

export interface PluginError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export async function runBeforeQuery(
  query: unknown,
  ctx: { plugins: DatafnPlugin[]; schema: any },
  plugins: DatafnPlugin[],
): Promise<{ ok: true; query: unknown } | { ok: false; error: PluginError }> {
  const hookCtx: DatafnHookContext = { env: "server", schema: ctx.schema };
  const result = await runBeforeHook(plugins, "server", "beforeQuery", hookCtx, query);
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, query: result.value };
}

export async function runAfterQuery(
  query: unknown,
  result: unknown,
  ctx: { plugins: DatafnPlugin[]; schema: any },
  plugins: DatafnPlugin[],
): Promise<unknown> {
  const hookCtx: DatafnHookContext = { env: "server", schema: ctx.schema };
  await runAfterHook(plugins, "server", "afterQuery", hookCtx, query, result);
  return result;
}

export async function runBeforeMutation(
  mutation: unknown,
  ctx: { plugins: DatafnPlugin[]; schema: any },
  plugins: DatafnPlugin[],
): Promise<{ ok: true; mutation: unknown } | { ok: false; error: PluginError }> {
  const hookCtx: DatafnHookContext = { env: "server", schema: ctx.schema };
  const result = await runBeforeHook(plugins, "server", "beforeMutation", hookCtx, mutation);
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, mutation: result.value };
}

export async function runAfterMutation(
  mutation: unknown,
  result: unknown,
  ctx: { plugins: DatafnPlugin[]; schema: any },
  plugins: DatafnPlugin[],
): Promise<void> {
  const hookCtx: DatafnHookContext = { env: "server", schema: ctx.schema };
  await runAfterHook(plugins, "server", "afterMutation", hookCtx, mutation, result);
}

export async function runBeforeSync(
  phase: "seed" | "clone" | "pull" | "push",
  payload: unknown,
  ctx: { plugins: DatafnPlugin[]; schema: any },
  plugins: DatafnPlugin[],
): Promise<{ ok: true; payload: unknown } | { ok: false; error: PluginError }> {
  const hookCtx: DatafnHookContext = { env: "server", schema: ctx.schema };
  const result = await runBeforeHook(plugins, "server", "beforeSync", hookCtx, payload, [phase]);
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, payload: result.value };
}

export async function runAfterSync(
  phase: "seed" | "clone" | "pull" | "push",
  payload: unknown,
  result: unknown,
  ctx: { plugins: DatafnPlugin[]; schema: any },
  plugins: DatafnPlugin[],
): Promise<void> {
  const hookCtx: DatafnHookContext = { env: "server", schema: ctx.schema };
  await runAfterHook(plugins, "server", "afterSync", hookCtx, payload, result, [phase]);
}

/**
 * Check if a searchfn plugin is installed (server-only)
 */
export function hasSearchPlugin(plugins: DatafnPlugin[]): boolean {
  return plugins.filter((p) => p.runsOn.includes("server")).some((p) => p.name === "searchfn");
}
