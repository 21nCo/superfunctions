/**
 * Spelling of a generated two-factor challenge id. Other spellings are refused so
 * case- or accent-insensitive database collations cannot match a stored id.
 */
export const CANONICAL_CHALLENGE_ID = /^[a-z0-9_-]{1,255}$/;
