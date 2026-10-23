/**
 * PHASE_14 collaboration tests: TV-COLLAB-001 (list updates on publish), TV-COLLAB-002 (remote-changed banner).
 */

import { describe, it, expect } from "vitest";
import { applyEvents } from "../realtime/applyEvents.js";

describe("applyEvents", () => {
  describe("TV-COLLAB-001: list updates on publish event", () => {
    it("returns listShouldRefetch when event is publish and dataset matches list", () => {
      const result = applyEvents(
        { type: "event", dataset: "prod", docId: "post-1" },
        { openDocId: null, listDataset: "prod" }
      );
      expect(result.listShouldRefetch).toBe(true);
    });

    it("returns listShouldRefetch when event is patch and dataset matches list", () => {
      const result = applyEvents(
        { type: "doc.patch", dataset: "prod", docId: "post-1" },
        { openDocId: null, listDataset: "prod" }
      );
      expect(result.listShouldRefetch).toBe(true);
    });
  });

  describe("TV-COLLAB-002: editor shows remote-changed banner", () => {
    it("returns showRemoteChangedBanner when event doc is the open doc", () => {
      const result = applyEvents(
        { type: "doc.patch", dataset: "prod", docId: "post-1" },
        { openDocId: "post-1", listDataset: "prod" }
      );
      expect(result.showRemoteChangedBanner).toBe(true);
    });

    it("returns showRemoteChangedBanner when event doc is drafts.X and open is X", () => {
      const result = applyEvents(
        { type: "event", dataset: "prod", docId: "drafts.post-1" },
        { openDocId: "post-1", listDataset: "prod" }
      );
      expect(result.showRemoteChangedBanner).toBe(true);
    });

    it("does not set showRemoteChangedBanner when open doc is different", () => {
      const result = applyEvents(
        { type: "doc.patch", dataset: "prod", docId: "post-2" },
        { openDocId: "post-1", listDataset: "prod" }
      );
      expect(result.showRemoteChangedBanner).toBe(false);
    });
  });
});
