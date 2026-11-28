import type { ChangedRange, MdfnSelection, MdfnSidecar, SidecarAnchor, TextSelection } from "./types";
import { immutableValue, isImmutableValue } from "./immutable";

function mapPosition(position: number, range: ChangedRange, affinity: "before" | "after"): number {
  const removed = range.to - range.from;
  const delta = range.insertedLength - removed;
  if (position < range.from || (position === range.from && affinity === "before")) return position;
  if (position > range.to || (position === range.to && affinity === "after")) return position + delta;
  return affinity === "before" ? range.from : range.from + range.insertedLength;
}

function mapTextSelection(selection: TextSelection, range: ChangedRange): TextSelection {
  const collapsed = selection.anchor === selection.head;
  const forward = selection.anchor <= selection.head;
  const anchorAffinity = collapsed || !forward ? "after" : "before";
  const headAffinity = collapsed || forward ? "after" : "before";
  const anchor = mapPosition(selection.anchor, range, anchorAffinity);
  const head = mapPosition(selection.head, range, headAffinity);
  return anchor === selection.anchor && head === selection.head ? selection : { ...selection, anchor, head };
}

/**
 * Map the canonical editor selection through source changes. Node selections are
 * cleared because arbitrary source edits can invalidate their stable node id.
 */
export function mapSelection(selection: MdfnSelection, ranges: readonly ChangedRange[]): MdfnSelection {
  if (!selection || ranges.length === 0) return selection;
  if (selection.kind === "node") return null;
  return immutableValue(ranges.reduce<TextSelection>((current, range) => mapTextSelection(current, range), selection));
}

const hasOwn = (value: object, key: PropertyKey): boolean => Object.prototype.hasOwnProperty.call(value, key);

/**
 * Copy the own enumerable fields of `source` as a spread would, except that each
 * key in `overrides` takes its value from there and is never read from `source`.
 * An override key the source does not own is added after the copied fields.
 */
function copyWith(source: object, overrides: Readonly<Record<string, unknown>>): Record<PropertyKey, unknown> {
  const copy: Record<PropertyKey, unknown> = {};
  const define = (key: PropertyKey, value: unknown) => {
    Object.defineProperty(copy, key, { value, enumerable: true, writable: true, configurable: true });
  };
  for (const key of Reflect.ownKeys(source)) {
    if (!Object.prototype.propertyIsEnumerable.call(source, key)) continue;
    define(key, typeof key === "string" && hasOwn(overrides, key) ? overrides[key] : (source as Record<PropertyKey, unknown>)[key]);
  }
  for (const key of Object.keys(overrides)) if (!hasOwn(copy, key)) define(key, overrides[key]);
  return copy;
}

/** Normalize an array length the way native array traversal does (ToLength). */
function toLength(value: number): number {
  const length = Math.trunc(Number(value));
  return Number.isNaN(length) || length <= 0 ? 0 : Math.min(length, Number.MAX_SAFE_INTEGER);
}

/** Whether any slot below `length` holds a range; checked with `in`, so nothing is read. */
function hasRange(ranges: readonly ChangedRange[], length: number): boolean {
  for (let index = 0; index < length; index += 1) if (index in ranges) return true;
  return false;
}

export function mapAnchor(anchor: SidecarAnchor, ranges: readonly ChangedRange[]): SidecarAnchor {
  return mapAnchorIn(anchor, ranges, toLength(ranges.length), false);
}

/**
 * Ranges are visited as native reduce visits them: `length` is normalized once,
 * a slot appended later is not visited, a hole or a slot deleted before its turn
 * is skipped, and each slot is checked with `in` and then read before the range
 * is applied. With no populated range the anchor is returned unread, unless
 * `detach` asks for a copy of a caller-owned anchor.
 */
function mapAnchorIn(anchor: SidecarAnchor, ranges: readonly ChangedRange[], length: number, detach: boolean): SidecarAnchor {
  let index = 0;
  while (index < length && !(index in ranges)) index += 1;
  if (index === length && !detach) return anchor;
  // The first range is read before any anchor field, as reduce reads a slot before
  // its callback runs, so an anchor getter that changes the array cannot affect it.
  const firstRange = index < length ? ranges[index] : undefined;
  // Each field is read once, including one supplied through a prototype or getter,
  // and the result is built from those values only, so mapping edits together or
  // one call at a time gives the same anchor.
  const affinity = anchor.affinity;
  const originalFrom = anchor.from;
  const originalTo = anchor.to;
  let from = originalFrom;
  let to = originalTo;
  const apply = (range: ChangedRange) => {
    const mappedFrom = mapPosition(from, range, affinity === "before" ? "before" : "after");
    const mappedTo = mapPosition(to, range, (affinity ?? "after") === "after" ? "after" : "before");
    from = Math.min(mappedFrom, mappedTo);
    to = Math.max(mappedFrom, mappedTo);
  };
  if (index < length) apply(firstRange!);
  for (index += 1; index < length; index += 1) if (index in ranges) apply(ranges[index]!);
  // An unchanged anchor is reused only when this module already detached it; a
  // caller-owned anchor is copied so later changes to it cannot reach the result.
  if (isImmutableValue(anchor) && from === originalFrom && to === originalTo) return anchor;
  const overrides = affinity !== undefined || hasOwn(anchor, "affinity") ? { from, to, affinity } : { from, to };
  return copyWith(anchor, overrides) as unknown as SidecarAnchor;
}

export function mapSidecar(sidecar: MdfnSidecar | undefined, ranges: readonly ChangedRange[]): MdfnSidecar | undefined {
  if (!sidecar) return sidecar;
  // With no populated range the sidecar is returned unread, as for empty ranges.
  const length = toLength(ranges.length);
  if (!hasRange(ranges, length)) return sidecar;
  // Unchanged parts are reused only from a sidecar this module already detached.
  // Any other input is copied field by field, so values supplied through getters
  // or a prototype are kept, as they were before reuse was added.
  const reusable = isImmutableValue(sidecar);
  let changed = false;
  const mapEntry = <T extends { readonly anchor: SidecarAnchor }>(entry: T): T => {
    const current = entry.anchor;
    // A caller-owned anchor is always copied with its fields read, so an inherited
    // affinity is kept even if a getter has emptied the ranges by now.
    const anchor = mapAnchorIn(current, ranges, length, !reusable);
    if (reusable && anchor === current) return entry;
    changed = true;
    return copyWith(entry, { anchor }) as unknown as T;
  };
  // A null collection is kept as read, so sidecar validation still rejects it.
  // Each collection is mapped before the next one is read, as before reuse was added.
  const readComments = sidecar.comments;
  const comments = readComments == null ? readComments : readComments.map(mapEntry);
  const readSuggestions = sidecar.suggestions;
  const suggestions = readSuggestions == null ? readSuggestions : readSuggestions.map(mapEntry);
  if (reusable && !changed) return sidecar;
  // comments and suggestions come only from the values read and mapped above, so a
  // getter is never read twice and every kept anchor went through mapAnchor.
  const overrides: Record<string, unknown> = {};
  if (comments !== undefined || hasOwn(sidecar, "comments")) overrides.comments = comments;
  if (suggestions !== undefined || hasOwn(sidecar, "suggestions")) overrides.suggestions = suggestions;
  return immutableValue(copyWith(sidecar, overrides) as unknown as MdfnSidecar);
}
