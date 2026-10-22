/**
 * `apifn sdk generate` — generate an SDK package from an operation catalog.
 *
 * The catalog comes from `--catalog` (built by @apifn/contracts) or is built from
 * `--spec` and `--manifest`. Only files the generator owns are written; the
 * target's custom-code area is never touched.
 */

import path from "node:path";
import { readFile } from "node:fs/promises";
import { buildOperationCatalog } from "@apifn/contracts";
import { generateSdk, SDK_TARGETS, writeSdk, type SdkDiagnostic } from "@apifn/sdk";
import type { Output } from "../utils/output.js";

export interface SdkGenerateCommandOptions {
  /** SDK config file: `{ target, unsupported?, options }`. */
  configPath?: string;
  catalogPath?: string;
  specPath?: string;
  manifestPath?: string;
  outDir?: string;
  /** Exit 1 when the output directory differs from what generation would write; write nothing. */
  check?: boolean;
  format?: "text" | "json";
  cwd?: string;
  output: Output;
  writeStdout?: (text: string) => void;
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, "utf8")) as unknown;
}

function describe(diagnostic: { severity: string; code: string; pointer?: string; message: string }): string {
  return `${diagnostic.severity} ${diagnostic.code}${diagnostic.pointer ? ` ${diagnostic.pointer}` : ""}: ${diagnostic.message}`;
}

export async function runSdkGenerateCommand(options: SdkGenerateCommandOptions): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const write = options.writeStdout ?? ((text: string) => process.stdout.write(text));
  const json = options.format === "json";
  const usage = (message: string) => {
    options.output.error(message);
    return 2;
  };
  if (!options.configPath) return usage("Missing --sdk-config <path>.");
  if (!options.outDir) return usage("Missing --out <dir>.");
  if (Boolean(options.catalogPath) === Boolean(options.specPath || options.manifestPath)) {
    return usage("Pass either --catalog <path>, or --spec <path> with --manifest <path>.");
  }
  if (options.specPath && !options.manifestPath) return usage("--spec needs --manifest <path>.");
  if (options.manifestPath && !options.specPath) return usage("--manifest needs --spec <path>.");

  let config: unknown;
  let catalog: unknown;
  const inputDiagnostics: Array<{ severity: string; code: string; pointer?: string; message: string }> = [];
  try {
    config = await readJson(path.resolve(cwd, options.configPath));
  } catch (error) {
    return usage(`Could not read SDK config ${options.configPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (options.catalogPath) {
    try {
      catalog = await readJson(path.resolve(cwd, options.catalogPath));
    } catch (error) {
      return usage(`Could not read catalog ${options.catalogPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    let spec: string;
    let manifest: unknown;
    try {
      spec = await readFile(path.resolve(cwd, options.specPath!), "utf8");
      manifest = await readJson(path.resolve(cwd, options.manifestPath!));
    } catch (error) {
      return usage(`Could not read spec or manifest: ${error instanceof Error ? error.message : String(error)}`);
    }
    const built = buildOperationCatalog(spec, manifest);
    inputDiagnostics.push(...built.diagnostics);
    catalog = built.catalog;
    if (!catalog) {
      for (const diagnostic of built.diagnostics) options.output.error(describe(diagnostic));
      if (json) write(`${JSON.stringify({ ok: false, diagnostics: built.diagnostics }, null, 2)}\n`);
      return 1;
    }
  }

  const result = generateSdk({ catalog, config, targets: SDK_TARGETS });
  const outDir = path.resolve(cwd, options.outDir);
  const written = result.ok ? await writeSdk(outDir, result, { dryRun: options.check }) : null;
  const diagnostics: SdkDiagnostic[] = [...result.diagnostics, ...(written?.diagnostics ?? [])];
  const ok = result.ok && written?.ok === true;
  const drift = written ? written.written.length + written.deleted.length + written.seeded.length > 0 : false;

  if (json) {
    write(
      `${JSON.stringify(
        {
          ok: ok && !(options.check && drift),
          check: options.check === true,
          outDir,
          manifest: result.manifest,
          catalogDiagnostics: inputDiagnostics,
          diagnostics,
          files: written && { written: written.written, unchanged: written.unchanged, deleted: written.deleted, seeded: written.seeded },
        },
        null,
        2
      )}\n`
    );
  } else {
    for (const diagnostic of inputDiagnostics) options.output.warn(describe(diagnostic));
    for (const diagnostic of diagnostics) {
      if (diagnostic.severity === "error") options.output.error(describe(diagnostic));
      else options.output.warn(describe(diagnostic));
    }
  }
  if (!ok || !written || !result.manifest) {
    if (!json) {
      if (!result.ok) options.output.error("SDK generation failed; nothing was written.");
      else if (options.check) options.output.error(`${outDir} cannot be checked: resolve the output conflicts above.`);
      else options.output.error(`${outDir} conflicts with the generated SDK; nothing was written.`);
    }
    return 1;
  }
  const { manifest } = result;
  if (options.check) {
    if (!json) {
      if (drift) options.output.error(`${outDir} is out of date: ${[...written.written, ...written.deleted, ...written.seeded].join(", ")}`);
      else options.output.success(`${outDir} is up to date.`);
    }
    return drift ? 1 : 0;
  }
  if (!json) {
    options.output.success(
      `Generated ${manifest.package.name} ${manifest.package.version} (${manifest.target.id}) into ${outDir}: ` +
        `${written.written.length} written, ${written.unchanged.length} unchanged, ${written.deleted.length} deleted, ${written.seeded.length} seeded.`
    );
    const unsupported = manifest.operations.excluded.filter((entry) => entry.reason === "unsupported");
    if (unsupported.length > 0) options.output.warn(`Excluded unsupported operations: ${unsupported.map((entry) => entry.id).join(", ")}.`);
  }
  return 0;
}
