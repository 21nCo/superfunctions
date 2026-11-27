import { createManifest, type CreateManifestOptions } from "./manifest.js";
import { McpFnRegistry } from "./registry.js";
import { registryInternals } from "./registry-internals.js";
import {
  createMcpFnServer,
  resolveMcpFnServerCapabilities,
  type McpFnServer,
  type McpFnServerOptions,
} from "./server.js";
import type {
  McpFnManifest,
  McpFnPromptDefinition,
  McpFnResourceDefinition,
  McpFnResourceTemplateDefinition,
  McpFnServerInfo,
  McpFnToolDefinition,
} from "./types.js";

export interface McpFnServerDeclarationOptions<TContext = undefined>
  extends CreateManifestOptions {
  info: McpFnServerInfo;
  tools?: McpFnToolDefinition<TContext>[];
  resources?: McpFnResourceDefinition<TContext>[];
  resourceTemplates?: McpFnResourceTemplateDefinition<TContext>[];
  prompts?: McpFnPromptDefinition<TContext>[];
  /** Reuse an existing registry while adopting the declaration/runtime split. */
  registry?: McpFnRegistry<TContext>;
}

export type McpFnServerRuntimeOptions<TContext> = Omit<
  McpFnServerOptions<TContext>,
  "info" | "registry" | "additionalCapabilities" | keyof CreateManifestOptions
>;


/**
 * Side-effect-free application declaration. The same registry and manifest
 * feed production transports, deterministic tests, and release tooling.
 */
export class McpFnServerDeclaration<TContext = undefined> {
  readonly info: McpFnServerInfo;
  readonly registry: McpFnRegistry<TContext>;
  private readonly manifestOptions: CreateManifestOptions;

  constructor(options: McpFnServerDeclarationOptions<TContext>) {
    this.info = options.info;
    // Always own a copy of a supplied registry: capabilities are resolved
    // here, so later registrations on the caller's registry must not change
    // this declaration's tools without changing its manifest.
    this.registry = options.registry
      ? registryInternals.declarationCopy(options.registry)
      : new McpFnRegistry<TContext>();
    try {
      for (const tool of options.tools ?? []) this.registry.register(tool);
      for (const resource of options.resources ?? []) this.registry.registerResource(resource);
      for (const template of options.resourceTemplates ?? []) {
        this.registry.registerResourceTemplate(template);
      }
      for (const prompt of options.prompts ?? []) this.registry.registerPrompt(prompt);
      const capabilities = resolveMcpFnServerCapabilities(
        this.registry,
        options.capabilities,
        Boolean(this.registry.capabilities().tasks),
      );
      this.manifestOptions = {
        protocolVersions: options.protocolVersions,
        transports: options.transports,
        extensions: options.extensions,
        capabilities,
        clientRequirements: options.clientRequirements,
      };
    } catch (error) {
      // The copy is discarded: a corrected declaration over the same registry
      // reuses what its custom compiler compiled.
      registryInternals.abandonCopy(this.registry);
      throw error;
    }
  }

  manifest(): McpFnManifest {
    return createManifest(this.info, this.registry, this.manifestOptions);
  }

  createServer(
    runtime: McpFnServerRuntimeOptions<TContext> = {},
  ): McpFnServer<TContext> {
    if (Object.hasOwn(runtime, "additionalCapabilities") || Object.hasOwn(runtime, "capabilities")) {
      throw new Error(
        "McpFn declaration capabilities must be configured on defineMcpFnServer(), not createServer()",
      );
    }
    return createMcpFnServer({
      ...runtime,
      ...this.manifestOptions,
      info: this.info,
      registry: this.registry,
      additionalCapabilities: this.manifestOptions.capabilities,
    });
  }
}

export function defineMcpFnServer<TContext = undefined>(
  options: McpFnServerDeclarationOptions<TContext>,
): McpFnServerDeclaration<TContext> {
  return new McpFnServerDeclaration(options);
}
