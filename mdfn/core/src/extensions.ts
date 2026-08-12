import { hashValue } from "./hash";
import type { EditorCommand, MdfnDiagnostic, MdfnDocument, MdfnExtension } from "./types";

export class ExtensionGraphError extends Error {
  readonly code: string;
  readonly extension?: string;

  constructor(code: string, message: string, extension?: string) {
    super(message);
    this.name = "ExtensionGraphError";
    this.code = code;
    this.extension = extension;
  }
}

export interface ResolvedExtensionRegistry {
  readonly extensions: readonly MdfnExtension[];
  readonly schemaHash: string;
  readonly commands: Readonly<Record<string, EditorCommand>>;
  diagnose(document: MdfnDocument): readonly MdfnDiagnostic[];
  migrate(document: MdfnDocument, fromVersion: number, toVersion: number): MdfnDocument;
}

function assertName(value: string, label: string): void {
  if (!/^[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)*$/.test(value)) {
    throw new ExtensionGraphError("MDFN_EXTENSION_NAME_INVALID", `${label} has invalid name: ${value}`, value);
  }
}

export function resolveExtensions(input: readonly MdfnExtension[]): ResolvedExtensionRegistry {
  const byName = new Map<string, MdfnExtension>();
  for (const extension of input) {
    assertName(extension.name, "Extension");
    if (byName.has(extension.name)) {
      throw new ExtensionGraphError("MDFN_EXTENSION_DUPLICATE", `Duplicate extension: ${extension.name}`, extension.name);
    }
    if (!extension.version.trim()) {
      throw new ExtensionGraphError("MDFN_EXTENSION_VERSION_INVALID", `Extension ${extension.name} requires a version`, extension.name);
    }
    if (extension.security?.executesContent) {
      throw new ExtensionGraphError(
        "MDFN_EXTENSION_EXECUTION_FORBIDDEN",
        `Extension ${extension.name} cannot execute content inside the portable profile`,
        extension.name,
      );
    }
    byName.set(extension.name, extension);
  }

  for (const extension of input) {
    for (const dependency of extension.dependencies ?? []) {
      if (!byName.has(dependency)) {
        throw new ExtensionGraphError(
          "MDFN_EXTENSION_DEPENDENCY_MISSING",
          `Extension ${extension.name} requires ${dependency}`,
          extension.name,
        );
      }
    }
    for (const conflict of extension.conflicts ?? []) {
      if (byName.has(conflict)) {
        throw new ExtensionGraphError(
          "MDFN_EXTENSION_CONFLICT",
          `Extension ${extension.name} conflicts with ${conflict}`,
          extension.name,
        );
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const ordered: MdfnExtension[] = [];
  const visit = (name: string, path: readonly string[]): void => {
    if (visited.has(name)) return;
    if (visiting.has(name)) {
      throw new ExtensionGraphError(
        "MDFN_EXTENSION_CYCLE",
        `Extension dependency cycle: ${[...path, name].join(" -> ")}`,
        name,
      );
    }
    visiting.add(name);
    const extension = byName.get(name)!;
    for (const dependency of extension.dependencies ?? []) visit(dependency, [...path, name]);
    visiting.delete(name);
    visited.add(name);
    ordered.push(extension);
  };

  for (const extension of [...input].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.name.localeCompare(b.name))) {
    visit(extension.name, []);
  }

  const commands: Record<string, EditorCommand> = {};
  for (const extension of ordered) {
    for (const [name, command] of Object.entries(extension.commands ?? {})) {
      const qualified = `${extension.name}:${name}`;
      if (commands[qualified]) {
        throw new ExtensionGraphError("MDFN_EXTENSION_COMMAND_DUPLICATE", `Duplicate command: ${qualified}`, extension.name);
      }
      commands[qualified] = command;
    }
  }

  const schemaHash = hashValue(
    ordered.map((extension) => ({
      name: extension.name,
      version: extension.version,
      schema: extension.schema ?? null,
      preservation: extension.preservation,
      security: extension.security ?? null,
    })),
  );

  return {
    extensions: ordered,
    schemaHash,
    commands,
    diagnose(document) {
      return ordered.flatMap((extension) => extension.diagnostics?.(document) ?? []);
    },
    migrate(document, fromVersion, toVersion) {
      if (fromVersion === toVersion) return document;
      if (fromVersion > toVersion) {
        throw new ExtensionGraphError("MDFN_SCHEMA_DOWNGRADE_FORBIDDEN", "Schema downgrades are not supported");
      }
      let current = document;
      let version = fromVersion;
      while (version < toVersion) {
        const migrations = ordered
          .flatMap((extension) => extension.migrations ?? [])
          .filter((migration) => migration.from === version)
          .sort((a, b) => a.to - b.to);
        const next = migrations.find((migration) => migration.to <= toVersion);
        if (!next) {
          throw new ExtensionGraphError(
            "MDFN_SCHEMA_MIGRATION_MISSING",
            `No schema migration from version ${version} to ${toVersion}`,
          );
        }
        current = next.migrate(current);
        version = next.to;
      }
      return current;
    },
  };
}
