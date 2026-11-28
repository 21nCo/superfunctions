import type { McpFnRegistry } from "./registry.js";

/**
 * Package-internal hooks between McpFnRegistry and a server declaration.
 * Not exported from the package entry point.
 */
export const registryInternals = {
  /** The copy a server declaration registers on (a clone()). */
  declarationCopy: <TContext>(registry: McpFnRegistry<TContext>): McpFnRegistry<TContext> =>
    registry.clone(),
  /**
   * End a declaration copy's construction. A discarded copy parks its compiles
   * for the next declaration over its source; either way the copy keeps no
   * declaration retries afterwards.
   */
  settleCopy: <TContext>(_copy: McpFnRegistry<TContext>, _abandoned: boolean): void => {},
};

/**
 * The key of a package-internal, non-enumerable McpFnRegistry method that
 * returns the output validator the registry applies to a tool's results (the
 * one its compileSchema, or the built-in compiler, returned), or undefined.
 * A registered symbol, so the `@mcpfn/core/openapi` bundle reaches the root
 * entry's registry without a public export.
 */
export const OUTPUT_VALIDATOR: unique symbol = Symbol.for("@mcpfn/core:registry-output-validator");
