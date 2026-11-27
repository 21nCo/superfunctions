/**
 * Package-internal hooks between McpFnRegistry and the modules that drive it.
 * Not exported from the package entry point.
 */
export const registryInternals: {
  /** Park the compiles of a server declaration's copy that was discarded. */
  abandonCopy: (registry: object) => void;
} = { abandonCopy: () => {} };
