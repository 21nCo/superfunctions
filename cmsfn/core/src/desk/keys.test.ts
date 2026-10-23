import { describe, it, expect } from "vitest";
import { deskNodeKeys, deskRootKey } from "./keys.js";
import type { CmsfnDeskNode } from "./types.js";

describe("deskRootKey", () => {
  it("returns stable root key", () => {
    expect(deskRootKey()).toBe("0");
  });
});

describe("deskNodeKeys", () => {
  it("returns single entry for non-group node", () => {
    const node: CmsfnDeskNode = {
      kind: "documentList",
      title: "Posts",
      dataset: "prod",
      types: ["post"],
    };
    const entries = deskNodeKeys(node);
    expect(entries).toHaveLength(1);
    expect(entries[0].key).toBe("0");
    expect(entries[0].node).toBe(node);
  });

  it("returns deterministic keys for flat group", () => {
    const node: CmsfnDeskNode = {
      kind: "group",
      title: "Content",
      children: [
        { kind: "documentList", title: "Posts", dataset: "prod", types: ["post"] },
        { kind: "documentList", title: "Pages", dataset: "prod", types: ["page"] },
      ],
    };
    const entries = deskNodeKeys(node);
    expect(entries).toHaveLength(3); // group + 2 children
    expect(entries[0].key).toBe("0");
    expect(entries[0].node.kind).toBe("group");
    expect(entries[1].key).toBe("0-0");
    expect(entries[2].key).toBe("0-1");
  });

  it("returns deterministic keys for nested groups", () => {
    const node: CmsfnDeskNode = {
      kind: "group",
      title: "Root",
      children: [
        {
          kind: "group",
          title: "Nested",
          children: [
            { kind: "documentList", title: "Posts", dataset: "prod", types: ["post"] },
          ],
        },
      ],
    };
    const entries = deskNodeKeys(node);
    expect(entries).toHaveLength(3);
    expect(entries[0].key).toBe("0");
    expect(entries[1].key).toBe("0-0");
    expect(entries[2].key).toBe("0-0-0");
  });

  it("same config produces same keys (determinism)", () => {
    const node: CmsfnDeskNode = {
      kind: "group",
      title: "Content",
      children: [
        { kind: "documentList", title: "Posts", dataset: "prod", types: ["post"] },
        { kind: "singleton", title: "Home", dataset: "prod", type: "page", id: "home" },
      ],
    };
    const a = deskNodeKeys(node);
    const b = deskNodeKeys(node);
    expect(a.map((e) => e.key)).toEqual(b.map((e) => e.key));
    expect(a.map((e) => e.key)).toEqual(["0", "0-0", "0-1"]);
  });

  it("empty group has only root key", () => {
    const node: CmsfnDeskNode = {
      kind: "group",
      title: "Empty",
      children: [],
    };
    const entries = deskNodeKeys(node);
    expect(entries).toHaveLength(1);
    expect(entries[0].key).toBe("0");
  });
});
