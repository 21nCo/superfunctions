import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export type FileExistsBehavior = "error" | "skip" | "overwrite";
export type ScaffoldErrorCode = "CLIFN_SCAFFOLD_EXISTS" | "CLIFN_SCAFFOLD_INVALID_PATH";

export type ScaffoldOperation =
  | {
      kind: "mkdir";
      path: string;
    }
  | {
      kind: "write-file";
      path: string;
      content: string;
      ifExists?: FileExistsBehavior;
    };

export interface ScaffoldResult {
  written: string[];
  skipped: string[];
}

export interface ScaffoldService {
  apply(operations: readonly ScaffoldOperation[], options?: { cwd?: string; dryRun?: boolean }): Promise<ScaffoldResult>;
}

export class ScaffoldError extends Error {
  readonly code: ScaffoldErrorCode;

  constructor(code: ScaffoldErrorCode, message: string) {
    super(message);
    this.name = "ScaffoldError";
    this.code = code;
  }
}

function isWithinRoot(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const result = await stat(filePath);
    return result.isFile();
  } catch {
    return false;
  }
}

function resolveOperationPath(root: string, inputPath: string): string {
  const resolved = path.resolve(root, inputPath);
  if (!isWithinRoot(root, resolved)) {
    throw new ScaffoldError("CLIFN_SCAFFOLD_INVALID_PATH", "Scaffold path escapes the configured working directory.");
  }
  return resolved;
}

export function createScaffold(): ScaffoldService {
  return {
    async apply(operations, options = {}) {
      const cwd = path.resolve(options.cwd ?? process.cwd());
      const dryRun = options.dryRun ?? false;
      const written: string[] = [];
      const skipped: string[] = [];

      for (const operation of operations) {
        const resolvedPath = resolveOperationPath(cwd, operation.path);
        const relativePath = path.relative(cwd, resolvedPath) || path.basename(resolvedPath);

        if (operation.kind === "mkdir") {
          if (!dryRun) {
            await mkdir(resolvedPath, { recursive: true });
          }
          continue;
        }

        const ifExists = operation.ifExists ?? "error";
        const exists = await fileExists(resolvedPath);

        if (exists && ifExists === "skip") {
          skipped.push(relativePath);
          continue;
        }

        if (exists && ifExists === "error") {
          throw new ScaffoldError("CLIFN_SCAFFOLD_EXISTS", `Scaffold target already exists: ${relativePath}`);
        }

        if (!dryRun) {
          await mkdir(path.dirname(resolvedPath), { recursive: true });
          await writeFile(resolvedPath, operation.content, "utf8");
        }

        written.push(relativePath);
      }

      return {
        written,
        skipped,
      };
    },
  };
}
