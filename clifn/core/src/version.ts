/**
 * The closed version grammar of the update check (D13): `MAJOR.MINOR.PATCH`, an optional `-prerelease` of
 * dot-separated identifiers (`[0-9A-Za-z-]+`, numeric ones without leading zeros) and optional `+build` metadata,
 * which is ignored. Precedence follows SemVer 2.0.0 section 11. Numbers are compared as decimal text, so any length
 * compares exactly. Not part of the package's public exports.
 */

const NUMERIC = "0|[1-9][0-9]*";
const PRERELEASE_IDENTIFIER = `(?:${NUMERIC}|[0-9]*[A-Za-z-][0-9A-Za-z-]*)`;
const BUILD_IDENTIFIER = "[0-9A-Za-z-]+";
const VERSION_PATTERN = new RegExp(
  `^(${NUMERIC})\\.(${NUMERIC})\\.(${NUMERIC})` +
    `(?:-(${PRERELEASE_IDENTIFIER}(?:\\.${PRERELEASE_IDENTIFIER})*))?` +
    `(?:\\+${BUILD_IDENTIFIER}(?:\\.${BUILD_IDENTIFIER})*)?$`
);

/** Longest version text the grammar accepts; longer text is not a version (bounds the regex and the notice). */
export const MAX_VERSION_LENGTH = 256;

export interface ParsedVersion {
  readonly major: string;
  readonly minor: string;
  readonly patch: string;
  /** Empty for a release. */
  readonly prerelease: readonly string[];
}

export function parseVersion(text: unknown): ParsedVersion | null {
  if (typeof text !== "string" || text.length > MAX_VERSION_LENGTH) {
    return null;
  }
  const match = VERSION_PATTERN.exec(text);
  if (!match) {
    return null;
  }
  return {
    major: match[1]!,
    minor: match[2]!,
    patch: match[3]!,
    prerelease: match[4] === undefined ? [] : match[4].split("."),
  };
}

function isNumeric(identifier: string): boolean {
  return /^[0-9]+$/.test(identifier);
}

/** Compares decimal numbers without leading zeros. */
function compareNumeric(a: string, b: string): number {
  if (a.length !== b.length) {
    return a.length < b.length ? -1 : 1;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareIdentifiers(a: string, b: string): number {
  const aNumeric = isNumeric(a);
  const bNumeric = isNumeric(b);
  if (aNumeric && bNumeric) {
    return compareNumeric(a, b);
  }
  if (aNumeric !== bNumeric) {
    // Numeric identifiers have lower precedence than alphanumeric ones.
    return aNumeric ? -1 : 1;
  }
  // ASCII sort order.
  return a < b ? -1 : a > b ? 1 : 0;
}

/** SemVer 2.0.0 precedence: negative, zero or positive as `a` is lower than, equal to or greater than `b`. */
export function compareParsedVersions(a: ParsedVersion, b: ParsedVersion): number {
  const core =
    compareNumeric(a.major, b.major) || compareNumeric(a.minor, b.minor) || compareNumeric(a.patch, b.patch);
  if (core !== 0) {
    return core;
  }
  const aPre = a.prerelease;
  const bPre = b.prerelease;
  if (aPre.length === 0 || bPre.length === 0) {
    // A release has higher precedence than any of its prereleases.
    return aPre.length === bPre.length ? 0 : aPre.length === 0 ? 1 : -1;
  }
  const shared = Math.min(aPre.length, bPre.length);
  for (let index = 0; index < shared; index += 1) {
    const order = compareIdentifiers(aPre[index]!, bPre[index]!);
    if (order !== 0) {
      return order;
    }
  }
  return aPre.length === bPre.length ? 0 : aPre.length < bPre.length ? -1 : 1;
}

/** `compareParsedVersions` on text; `null` when either side is outside the grammar. */
export function compareVersions(a: string, b: string): number | null {
  const left = parseVersion(a);
  const right = parseVersion(b);
  return left && right ? Math.sign(compareParsedVersions(left, right)) : null;
}
