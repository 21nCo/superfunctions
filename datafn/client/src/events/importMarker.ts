/**
 * Context of the change events importData emits for the records it wrote.
 * Recognised by identity, so a caller's own mutation context can never pass
 * for it, and frozen, so a subscriber cannot change it for later imports.
 */
export const IMPORT_CONTEXT: Readonly<{ source: "import" }> = Object.freeze({
  source: "import",
});

/** Whether an event's context is the import marker. */
export function isImportContext(context: unknown): boolean {
  return context === IMPORT_CONTEXT;
}
