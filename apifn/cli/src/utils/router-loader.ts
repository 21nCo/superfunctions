import { createJiti } from "jiti";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Router } from "@superfunctions/http";

function isRouter(value: unknown): value is Router<unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as Router<unknown>).getRoutes === "function"
  );
}

/**
 * jiti's default interop for a natively imported namespace, for the exports the loader reads: a
 * CommonJS module's exports object is its `default`, and a name the namespace lacks is read from it.
 */
function interopDefault(namespace: Record<string, unknown>, enabled: boolean): Record<string, unknown> {
  const inner = namespace.default as Record<string, unknown> | null | undefined;
  if (!enabled || inner === null || (typeof inner !== "object" && typeof inner !== "function")) return namespace;
  const unwrapped = namespace.__esModule && !isRouter(inner) && typeof inner.default === "function" ? inner.default : inner;
  // A default that is already a router leaves every other property of it unread.
  return { ...namespace, default: unwrapped, router: "router" in namespace ? namespace.router : isRouter(inner) ? undefined : inner.router };
}

/**
 * Loads the router module once and returns it with the file that load read: the operand
 * (extensionless or a directory) is resolved once, and that very file is imported, so the file
 * named is the module loaded, never a second lookup made after the import. `beforeImport` is
 * called with that file right before the import (apifn check binds its state there).
 */
export async function loadRouterModule(
  routerPath: string,
  cwd = process.cwd(),
  beforeImport?: (file: string) => void
): Promise<{ router: Router<unknown>; file: string }> {
  const resolved = path.isAbsolute(routerPath) ? routerPath : path.resolve(cwd, routerPath);
  const jiti = createJiti(cwd, { moduleCache: false });
  let file = resolved;
  let load = () => jiti.import(resolved);
  try {
    const url = jiti.esmResolve(resolved);
    file = url.startsWith("file:") ? fileURLToPath(url) : url;
    // esmResolve applied JITI_ALIAS once: `file` itself is evaluated (no second alias lookup), and
    // its dependencies resolve with the caller's alias table unchanged.
    const evaluate = async () => jiti.evalModule(readFileSync(file, "utf8"), { id: file, filename: file, async: true });
    // With tryNative, jiti.import loaded the file natively first (no alias applies to a file URL) with its interop, then fell back.
    // Only a failed native import falls back: a module that loaded is never evaluated again.
    const native = () => import(pathToFileURL(file).href).then((ns) => interopDefault(ns, jiti.options.interopDefault !== false), evaluate);
    load = jiti.options.tryNative ? native : evaluate;
  } catch {
    // Not resolvable: the import below reports the missing module as it always has.
  }
  beforeImport?.(file);
  const loaded = await load() as Record<string, unknown>;

  const candidates = [loaded?.default, loaded?.router, loaded];
  const router = candidates.find((candidate) => isRouter(candidate));

  if (!router) {
    throw new Error(
      `Router export not found in ${resolved}. Expected default export or named export 'router'.`
    );
  }

  return { router, file };
}

export async function loadRouter(
  routerPath: string,
  cwd = process.cwd()
): Promise<Router<unknown>> {
  return (await loadRouterModule(routerPath, cwd)).router;
}
