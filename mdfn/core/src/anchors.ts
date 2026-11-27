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

export function mapAnchor(anchor: SidecarAnchor, ranges: readonly ChangedRange[]): SidecarAnchor {
  if (ranges.length === 0) return anchor;
  // Affinity is read once, including one supplied through a prototype, and kept on
  // the result, so mapping edits together or one call at a time gives the same anchor.
  const affinity = anchor.affinity;
  let from = anchor.from;
  let to = anchor.to;
  // forEach skips holes in a sparse ranges array, as mapSelection's reduce does.
  ranges.forEach((range) => {
    const mappedFrom = mapPosition(from, range, affinity === "before" ? "before" : "after");
    const mappedTo = mapPosition(to, range, (affinity ?? "after") === "after" ? "after" : "before");
    from = Math.min(mappedFrom, mappedTo);
    to = Math.max(mappedFrom, mappedTo);
  });
  // An unchanged anchor is reused only when this module already detached it; a
  // caller-owned anchor is copied so later changes to it cannot reach the result.
  if (from === anchor.from && to === anchor.to && isImmutableValue(anchor)) return anchor;
  return { ...anchor, from, to, ...(affinity !== undefined ? { affinity } : {}) };
}

export function mapSidecar(sidecar: MdfnSidecar | undefined, ranges: readonly ChangedRange[]): MdfnSidecar | undefined {
  if (!sidecar || ranges.length === 0) return sidecar;
  // Unchanged parts are reused only from a sidecar this module already detached.
  // Any other input is copied field by field, so values supplied through getters
  // or a prototype are kept, as they were before reuse was added.
  const reusable = isImmutableValue(sidecar);
  let changed = false;
  const mapEntry = <T extends { readonly anchor: SidecarAnchor }>(entry: T): T => {
    const current = entry.anchor;
    const anchor = mapAnchor(current, ranges);
    if (reusable && anchor === current) return entry;
    changed = true;
    return { ...entry, anchor };
  };
  const comments = sidecar.comments?.map(mapEntry);
  const suggestions = sidecar.suggestions?.map(mapEntry);
  if (reusable && !changed) return sidecar;
  return immutableValue({ ...sidecar, ...(comments ? { comments } : {}), ...(suggestions ? { suggestions } : {}) });
}
