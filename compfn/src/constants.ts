/**
 * Limit constants (LIMIT-001).
 */

/** Default max evidence payload size: 512 KiB */
export const EVIDENCE_PAYLOAD_MAX_BYTES_DEFAULT = 524288;

/** Default max auditor pack export size: 50 MiB */
export const EXPORT_MAX_BYTES_DEFAULT = 50 * 1024 * 1024;

/** Max requirements per framework */
export const MAX_REQUIREMENTS_PER_FRAMEWORK = 1000;

/** Max control IDs per framework requirement */
export const MAX_CONTROL_IDS_PER_REQUIREMENT = 100;

/** Default readiness policy window (days): evidence with timestamp within this window counts for compliant. */
export const READINESS_WINDOW_DAYS_DEFAULT = 90;
