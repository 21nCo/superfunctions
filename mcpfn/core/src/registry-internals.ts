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
