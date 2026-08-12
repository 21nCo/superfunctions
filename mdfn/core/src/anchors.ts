import type { ChangedRange, MdfnSidecar, SidecarAnchor } from "./types";

function mapPosition(position: number, range: ChangedRange, affinity: "before" | "after"): number {
  const removed = range.to - range.from;
  const delta = range.insertedLength - removed;
  if (position < range.from || (position === range.from && affinity === "before")) return position;
  if (position > range.to || (position === range.to && affinity === "after")) return position + delta;
  return affinity === "before" ? range.from : range.from + range.insertedLength;
}

export function mapAnchor(anchor: SidecarAnchor, ranges: readonly ChangedRange[]): SidecarAnchor {
  return ranges.reduce<SidecarAnchor>((current, range) => {
    const affinity = current.affinity ?? "after";
    const from = mapPosition(current.from, range, affinity === "before" ? "before" : "after");
    const to = mapPosition(current.to, range, affinity === "after" ? "after" : "before");
    return { ...current, from: Math.min(from, to), to: Math.max(from, to) };
  }, anchor);
}

export function mapSidecar(sidecar: MdfnSidecar | undefined, ranges: readonly ChangedRange[]): MdfnSidecar | undefined {
  if (!sidecar || ranges.length === 0) return sidecar;
  return {
    ...sidecar,
    comments: sidecar.comments?.map((thread) => ({ ...thread, anchor: mapAnchor(thread.anchor, ranges) })),
    suggestions: sidecar.suggestions?.map((suggestion) => ({ ...suggestion, anchor: mapAnchor(suggestion.anchor, ranges) })),
  };
}
