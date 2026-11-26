/**
 * The most characters a region id may have: the server stores it as a
 * database key (`AUTHFN_DATABASE_KEY_MAX_LENGTH`).
 */
export const REGION_ID_MAX_LENGTH = 255;

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * Whether `value` is a region id AuthFn accepts. The server treats region
 * ids as opaque, so this checks only what every id satisfies: a non-empty
 * string of at most 255 characters with no control characters and no
 * leading or trailing whitespace (`aws:eu-west-1` is one).
 */
export function isRegionId(value: unknown): value is string {
  return (
    typeof value === 'string'
    && value.length > 0
    && Array.from(value).length <= REGION_ID_MAX_LENGTH
    && value.trim() === value
    && !CONTROL_CHARACTER.test(value)
  );
}
