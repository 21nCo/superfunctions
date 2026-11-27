import type { ChangedRange, MdfnSelection, MdfnSidecar, SidecarAnchor, TextSelection } from "./types";
import { immutableValue } from "./immutable";

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
  return ranges.reduce<SidecarAnchor>((current, range) => {
    const affinity = current.affinity ?? "after";
    const from = mapPosition(current.from, range, affinity === "before" ? "before" : "after");
    const to = mapPosition(current.to, range, affinity === "after" ? "after" : "before");
    const start = Math.min(from, to);
    const end = Math.max(from, to);
    return start === current.from && end === current.to ? current : { ...current, from: start, to: end };
  }, anchor);
}

export function mapSidecar(sidecar: MdfnSidecar | undefined, ranges: readonly ChangedRange[]): MdfnSidecar | undefined {
  if (!sidecar || ranges.length === 0) return sidecar;
  let changed = false;
  const mapEntry = <T extends { readonly anchor: SidecarAnchor }>(entry: T): T => {
    const anchor = mapAnchor(entry.anchor, ranges);
    if (anchor === entry.anchor) return entry;
    changed = true;
    return { ...entry, anchor };
  };
  const comments = sidecar.comments?.map(mapEntry);
  const suggestions = sidecar.suggestions?.map(mapEntry);
  if (!changed) return immutableValue(sidecar);
  return immutableValue({ ...sidecar, ...(comments ? { comments } : {}), ...(suggestions ? { suggestions } : {}) });
}
