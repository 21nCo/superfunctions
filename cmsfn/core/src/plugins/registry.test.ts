import { describe, it, expect } from "vitest";
import { createWidgetRegistry, createPaneRegistry } from "./registry.js";

describe("createWidgetRegistry", () => {
  it("returns null when no registration matches", () => {
    const r = createWidgetRegistry();
    expect(r.getWidgetId("post", "title", "primitive")).toBeNull();
  });

  it("returns widget id for typeName+fieldName (TV-PLUG-001 style)", () => {
    const r = createWidgetRegistry();
    r.register({ typeName: "post", fieldName: "body" }, "custom-richtext");
    expect(r.getWidgetId("post", "body", "richtext")).toBe("custom-richtext");
    expect(r.getWidgetId("post", "title", "primitive")).toBeNull();
  });

  it("last registration wins for same selector (TV-PLUG-002)", () => {
    const r = createWidgetRegistry();
    r.register({ typeName: "post", fieldName: "body" }, "first");
    r.register({ typeName: "post", fieldName: "body" }, "second");
    expect(r.getWidgetId("post", "body", "richtext")).toBe("second");
  });

  it("typeName+fieldName wins over fieldType only", () => {
    const r = createWidgetRegistry();
    r.register({ fieldType: "richtext" }, "fallback");
    r.register({ typeName: "post", fieldName: "body" }, "specific");
    expect(r.getWidgetId("post", "body", "richtext")).toBe("specific");
  });

  it("fieldType registration applies to any type/field", () => {
    const r = createWidgetRegistry();
    r.register({ fieldType: "richtext" }, "generic-richtext");
    expect(r.getWidgetId("post", "body", "richtext")).toBe("generic-richtext");
    expect(r.getWidgetId("page", "content", "richtext")).toBe("generic-richtext");
  });
});

describe("createPaneRegistry", () => {
  it("has and getRegisteredPaneIds are deterministic", () => {
    const r = createPaneRegistry();
    expect(r.has("audit/events")).toBe(false);
    r.register("audit/events");
    r.register("audit/webhooks");
    expect(r.has("audit/events")).toBe(true);
    expect(r.getRegisteredPaneIds()).toEqual(["audit/events", "audit/webhooks"]);
  });
});
