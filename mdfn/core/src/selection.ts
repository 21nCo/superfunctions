import { immutableValue } from "./immutable";
import type { MdfnSelection } from "./types";

export function validateMdfnSelection(selection: MdfnSelection, markdownLength: number): MdfnSelection {
  if (selection === null) return null;
  if (typeof selection !== "object" || Array.isArray(selection)) throw new TypeError("MDFN_SELECTION_INVALID");
  // Read each field once: fields may come through a prototype or a getter, and the
  // result must hold exactly the values that were validated.
  const kind: unknown = selection.kind;
  if (kind === "text") {
    if (Object.keys(selection).some((key) => !["kind", "anchor", "head"].includes(key))) {
      throw new TypeError("MDFN_SELECTION_INVALID");
    }
    const { anchor, head } = selection as { anchor: unknown; head: unknown };
    if (
      typeof anchor !== "number"
      || typeof head !== "number"
      || !Number.isInteger(anchor)
      || !Number.isInteger(head)
      || anchor < 0
      || head < 0
      || anchor > markdownLength
      || head > markdownLength
    ) {
      throw new RangeError("MDFN_SELECTION_RANGE_INVALID");
    }
    return immutableValue({ kind: "text", anchor, head });
  } else if (kind === "node") {
    if (Object.keys(selection).some((key) => !["kind", "nodeId"].includes(key))) {
      throw new TypeError("MDFN_SELECTION_INVALID");
    }
    const { nodeId } = selection as { nodeId: unknown };
    if (typeof nodeId !== "string" || nodeId.length === 0) throw new TypeError("MDFN_SELECTION_INVALID");
    return immutableValue({ kind: "node", nodeId });
  }
  throw new TypeError("MDFN_SELECTION_INVALID");
}
