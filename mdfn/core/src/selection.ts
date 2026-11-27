import { immutableValue } from "./immutable";
import type { MdfnSelection } from "./types";

export function validateMdfnSelection(selection: MdfnSelection, markdownLength: number): MdfnSelection {
  if (selection === null) return null;
  if (typeof selection !== "object" || Array.isArray(selection)) throw new TypeError("MDFN_SELECTION_INVALID");
  if (selection.kind === "text") {
    if (Object.keys(selection).some((key) => !["kind", "anchor", "head"].includes(key))) {
      throw new TypeError("MDFN_SELECTION_INVALID");
    }
    if (
      !Number.isInteger(selection.anchor)
      || !Number.isInteger(selection.head)
      || selection.anchor < 0
      || selection.head < 0
      || selection.anchor > markdownLength
      || selection.head > markdownLength
    ) {
      throw new RangeError("MDFN_SELECTION_RANGE_INVALID");
    }
    // Build the result from the validated values: fields inherited through a
    // prototype would be dropped by copying only own properties.
    return immutableValue({ kind: "text", anchor: selection.anchor, head: selection.head });
  } else if (selection.kind === "node") {
    if (
      Object.keys(selection).some((key) => !["kind", "nodeId"].includes(key))
      || typeof selection.nodeId !== "string"
      || selection.nodeId.length === 0
    ) {
      throw new TypeError("MDFN_SELECTION_INVALID");
    }
    return immutableValue({ kind: "node", nodeId: selection.nodeId });
  }
  throw new TypeError("MDFN_SELECTION_INVALID");
}
