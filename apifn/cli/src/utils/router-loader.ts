import { createJiti } from "jiti";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Router } from "@superfunctions/http";

function isRouter(value: unknown): value is Router<unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as Router<unknown>).getRoutes === "function"
  );
}

/**
 * Loads the router module once and returns it with the file that load read: the operand
 * (extensionless or a directory) is resolved once with jiti's resolver, and jiti.import loads that
 * operand with the same resolution, applying JITI_ALIAS once. `beforeImport` is
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
  try {
    const url = jiti.esmResolve(resolved);
    file = url.startsWith("file:") ? fileURLToPath(url) : url;
  } catch {
    // Not resolvable: the import below reports the missing module as it always has.
  }
  beforeImport?.(file);
  // jiti.import gets the operand, not `file`: JITI_ALIAS applies once, and its export interop is jiti's own.
  const loaded = await jiti.import(resolved) as Record<string, unknown>;

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
