/**
 * Deterministic stable keys for desk nodes derived from config path (position in tree).
 */

import type { CmsfnDeskNode } from "./types.js";

export interface DeskKeyEntry {
  key: string;
  node: CmsfnDeskNode;
}

/**
 * Produces a deterministic list of (key, node) for every node in the desk tree.
 * Keys are path indices from root, e.g. "0", "1", "0-0", "0-1", "1-0".
 * Order is stable: depth-first, children in array order.
 */
export function deskNodeKeys(root: CmsfnDeskNode): DeskKeyEntry[] {
  const out: DeskKeyEntry[] = [];

  function walk(node: CmsfnDeskNode, path: number[]): void {
    const key = path.length === 0 ? "0" : "0-" + path.join("-");
    out.push({ key, node });

    if (node.kind === "group" && node.children.length > 0) {
      node.children.forEach((child, i) => {
        walk(child, [...path, i]);
      });
    }
  }

  walk(root, []);
  return out;
}

/**
 * Returns a stable key for the given node when it is the only child at the root.
 * For use when you need a single-node key (e.g. root desk).
 */
export function deskRootKey(): string {
  return "0";
}
