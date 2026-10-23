/**
 * CmsFn limit constants (SPEC.md). Enforced deterministically.
 */

/** Max documents per release (add-time and publish). */
export const MAX_DOCS_PER_RELEASE = 500;

/** Max richtext blocks per field (client precheck + server validation reference). */
export const MAX_RICHTEXT_BLOCKS = 5000;
