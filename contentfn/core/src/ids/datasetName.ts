/**
 * Dataset name validation (SPEC: ^[a-z0-9][a-z0-9_-]{1,62}$).
 */

const DATASET_NAME_REGEX = /^[a-z0-9][a-z0-9_-]{1,62}$/;

/**
 * Returns true if the dataset name is valid.
 */
export function isValidDatasetName(name: string): boolean {
  return typeof name === "string" && DATASET_NAME_REGEX.test(name);
}

/**
 * Validates dataset name; returns a short reason when invalid.
 */
export function validateDatasetName(name: unknown): { ok: true; name: string } | { ok: false; reason: string } {
  if (typeof name !== "string") return { ok: false, reason: "Dataset name must be a string" };
  if (name.length === 0) return { ok: false, reason: "Dataset name cannot be empty" };
  if (!DATASET_NAME_REGEX.test(name)) {
    return {
      ok: false,
      reason: "Dataset name must match ^[a-z0-9][a-z0-9_-]{1,62}$",
    };
  }
  return { ok: true, name };
}
