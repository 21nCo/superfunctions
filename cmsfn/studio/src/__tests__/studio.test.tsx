/**
 * PHASE_03 UI tests: TV-STUDIO-BOOT-001, TV-DESK-STRUCT-001, TV-DATASET-SCOPE-001 (partial).
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { App, DeskTree, DatasetSelector, getInitialDataset } from "../index.js";
import type { CmsfnStudioConfig } from "cmsfn";

function fixedConfig(): CmsfnStudioConfig {
  return {
    contentfn: { baseUrl: "http://contentfn.test" },
    datasets: [
      { name: "prod", label: "Production" },
      { name: "staging", label: "Staging" },
    ],
    desk: {
      kind: "group",
      title: "Content",
      children: [
        { kind: "documentList", title: "Posts", dataset: "prod", types: ["post"] },
        { kind: "documentList", title: "Pages", dataset: "prod", types: ["page"] },
        { kind: "singleton", title: "Home", dataset: "prod", type: "page", id: "home" },
      ],
    },
    auth: { kind: "custom" },
  };
}

describe("PHASE_03: Studio boot + desk + dataset", () => {
  describe("TV-STUDIO-BOOT-001: studio boots", () => {
    it("loads Studio at root and desk navigation renders with groups/lists/singletons", () => {
      const config = fixedConfig();
      const { container } = render(<App config={config} />);
      const root = container.querySelector("[data-studio-root]");
      expect(root).toBeTruthy();
      const deskRoot = container.querySelector("[data-desk-root]");
      expect(deskRoot).toBeTruthy();
      expect(screen.getByText("Content")).toBeDefined();
      expect(screen.getByText("Posts")).toBeDefined();
      expect(screen.getByText("Pages")).toBeDefined();
      expect(screen.getByText("Home")).toBeDefined();
    });
  });

  describe("TV-DESK-STRUCT-001: deterministic desk structure", () => {
    it("same config produces identical node order and labels in two renders", () => {
      const config = fixedConfig();
      const { unmount: u1 } = render(<App config={config} />);
      const titles1 = Array.from(document.querySelectorAll("[data-desk-title]")).map((el) => el.textContent);
      u1();
      const { unmount: u2 } = render(<App config={config} />);
      const titles2 = Array.from(document.querySelectorAll("[data-desk-title]")).map((el) => el.textContent);
      u2();
      expect(titles1).toEqual(titles2);
      expect(titles1).toContain("Content");
      expect(titles1).toContain("Posts");
      expect(titles1).toContain("Pages");
      expect(titles1).toContain("Home");
    });
  });

  describe("TV-DATASET-SCOPE-001 (partial): dataset value used downstream", () => {
    it("initial dataset is first config dataset and selector shows selected value", () => {
      const config = fixedConfig();
      expect(getInitialDataset(config)).toBe("prod");
      const onDatasetChange = vi.fn();
      render(
        <DatasetSelector
          config={config}
          value="prod"
          onDatasetChange={onDatasetChange}
        />
      );
      const select = screen.getByRole("combobox", { name: /select dataset/i }) as HTMLSelectElement;
      expect(select.getAttribute("data-dataset-select-value")).toBe("prod");
      expect(select.value).toBe("prod");
      // App uses dataset state downstream; selector propagates via onDatasetChange
      expect(select).toBeDefined();
    });
  });
});
