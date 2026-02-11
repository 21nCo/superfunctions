/**
 * PHASE_14 plugin tests: TV-PLUG-001 (custom widget used), TV-PLUG-002 (last wins).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { registerWidget, getWidgetForField } from "../plugins/registerWidget.js";
import { renderField } from "../editor/renderField.js";
import type { ContentfnField } from "@contentfn/core";

// Reset module state between tests by re-registering; we test in order so no shared state across files.
const fieldBody: ContentfnField = {
  name: "body",
  type: { kind: "richtext" },
  required: false,
};

describe("PHASE_14: Widget extension", () => {
  describe("TV-PLUG-001: register custom widget", () => {
    it("custom widget is used for that field when registered", () => {
      registerWidget(
        { typeName: "post", fieldName: "body" },
        (props) => <div data-custom-widget="custom-body" data-value={String(props.value)}>{String(props.value)}</div>
      );

      const result = renderField(
        fieldBody,
        "body",
        "initial",
        () => {},
        null,
        { docTypeName: "post" }
      );
      const { container } = render(<>{result}</>);
      expect(container.querySelector('[data-custom-widget="custom-body"]')).toBeTruthy();
      expect(container.querySelector('[data-custom-widget="custom-body"]')?.getAttribute("data-value")).toBe("initial");
    });
  });

  describe("TV-PLUG-002: widget conflict resolved deterministically (last wins)", () => {
    it("second registration for same selector wins", () => {
      registerWidget({ typeName: "post", fieldName: "body" }, () => <span data-widget-id="first" />);
      registerWidget({ typeName: "post", fieldName: "body" }, () => <span data-widget-id="second" />);

      const result = renderField(fieldBody, "body", null, () => {}, null, { docTypeName: "post" });
      const { container } = render(<>{result}</>);
      expect(container.querySelector('[data-widget-id="second"]')).toBeTruthy();
      expect(container.querySelector('[data-widget-id="first"]')).toBeFalsy();
    });
  });
});

describe("getWidgetForField", () => {
  beforeEach(() => {
    // Rely on test order: no global reset of registry
  });

  it("returns null when no widget registered", () => {
    const c = getWidgetForField("unknownType", "unknownField", "primitive");
    expect(c).toBeNull();
  });
});
