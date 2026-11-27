import type { McpFnRegistry } from "./registry.js";

/**
 * Package-internal hooks between McpFnRegistry and a server declaration.
 * Not exported from the package entry point.
 */
export const registryInternals = {
  /** The copy a server declaration registers on (a clone()). */
  declarationCopy: <TContext>(registry: McpFnRegistry<TContext>): McpFnRegistry<TContext> =>
    registry.clone(),
  /** Park the compiles of a declaration copy that was discarded. */
  abandonCopy: (_registry: object): void => {},
};
