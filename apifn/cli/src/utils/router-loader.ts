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
    // With tryNative, jiti.import loaded the file natively first (no alias applies to a file URL) and fell back to jiti.
    load = jiti.options.tryNative ? () => import(pathToFileURL(file).href).catch(evaluate) : evaluate;
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
