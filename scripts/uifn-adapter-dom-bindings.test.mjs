import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  adapterDomBindingWiringIssues,
  adapterDomBindings,
  adapterDomBindingsSource,
  sharedAdapterInstallerIssues,
} from "./uifn-adapter-dom-bindings.mjs";

const catalog = JSON.parse(readFileSync(new URL("../uifn/catalog/generated/catalog.json", import.meta.url), "utf8"));

// Every primitive the adapter compounds wired a @uifn/dom binding for before the bindings became per-definition
// installers, with the bindings in the order the compounds created them. A primitive missing here gets none.
const EXPECTED = {
  AlertDialog: ["overlayDomBinding"],
  AngleSlider: ["rangeGestureDomBinding"],
  Autocomplete: ["popupDomBinding"],
  Carousel: ["rangeGestureDomBinding"],
  CheckboxGroup: ["rovingFocusDomBinding"],
  ColorPicker: ["popupDomBinding", "rovingFocusDomBinding", "rangeGestureDomBinding"],
  Combobox: ["popupDomBinding"],
  ContextMenu: ["menuDomBinding"],
  DatePicker: ["popupDomBinding"],
  Dialog: ["overlayDomBinding"],
  Drawer: ["overlayDomBinding"],
  Editable: ["rovingFocusDomBinding"],
  FloatingPanel: ["overlayDomBinding"],
  HoverCard: ["overlayDomBinding"],
  ImageCropper: ["rangeGestureDomBinding"],
  Listbox: ["rovingFocusDomBinding"],
  Menu: ["menuDomBinding"],
  Menubar: ["rovingFocusDomBinding"],
  NavigationMenu: ["navigationMenuDomBinding", "rovingFocusDomBinding"],
  Pagination: ["rovingFocusDomBinding"],
  PinInput: ["rovingFocusDomBinding"],
  Popover: ["overlayDomBinding"],
  RadioGroup: ["rovingFocusDomBinding"],
  ScrollArea: ["rangeGestureDomBinding"],
  SegmentGroup: ["rovingFocusDomBinding"],
  Select: ["popupDomBinding"],
  SignaturePad: ["rangeGestureDomBinding"],
  Slider: ["rangeGestureDomBinding"],
  Splitter: ["rangeGestureDomBinding"],
  Tabs: ["rovingFocusDomBinding"],
  ToggleGroup: ["rovingFocusDomBinding"],
  Toolbar: ["rovingFocusDomBinding"],
  Tooltip: ["overlayDomBinding"],
  Tour: ["overlayDomBinding"],
  TreeView: ["rovingFocusDomBinding"],
};

test("each catalog primitive gets exactly the DOM bindings the adapter compounds wired for it", () => {
  const names = new Set(catalog.primitives.map((primitive) => primitive.name));
  for (const name of Object.keys(EXPECTED)) assert.ok(names.has(name), `${name} is not in the catalog`);
  for (const primitive of catalog.primitives) {
    assert.deepEqual(adapterDomBindings(primitive), EXPECTED[primitive.name] ?? [], primitive.name);
  }
});

test("a definition imports its @uifn/dom installers and passes its own parts; one without bindings gets none", () => {
  assert.deepEqual(adapterDomBindingsSource({ name: "Badge", behaviorFamily: "display" }), { importLine: "", field: "" });
  assert.deepEqual(adapterDomBindingsSource({ name: "NavigationMenu", behaviorFamily: "menu-navigation" }), {
    importLine: "import { createUIFnRovingFocusAdapterBinding, uifnNavigationMenuAdapterBinding } from '@uifn/dom';\n",
    field: '\n  domBindings: [uifnNavigationMenuAdapterBinding, /* @__PURE__ */ createUIFnRovingFocusAdapterBinding({"stateKey":"focusedItem","parts":["trigger"]})],',
  });
  assert.equal(adapterDomBindingsSource({ name: "Tour", behaviorFamily: "modal-overlay" }).field, "\n  domBindings: [uifnTourOverlayAdapterBinding],");
  assert.equal(adapterDomBindingsSource({ name: "Menubar", behaviorFamily: "menu-navigation" }).field, "\n  domBindings: [/* @__PURE__ */ createUIFnRovingFocusAdapterBinding(uifnMenubarRovingTarget)],");
});

test("no generated definition carries another primitive's parts, so Tabs never names a PinInput or Splitter part", () => {
  const tabs = adapterDomBindingsSource({ name: "Tabs", behaviorFamily: "menu-navigation" });
  for (const foreign of ["Menubar", "PinInput", "Editable", "pageTrigger", "resizeHandle", "cropArea", "uifnPinInputRovingTarget"]) {
    assert.ok(!`${tabs.importLine}${tabs.field}`.includes(foreign), foreign);
  }
});

test("the wiring check fails a definition whose domBindings were disconnected, changed or added", () => {
  const tabs = { name: "Tabs", behaviorFamily: "menu-navigation" };
  const badge = { name: "Badge", behaviorFamily: "display" };
  const { importLine, field } = adapterDomBindingsSource(tabs);
  const wired = `${importLine}const TabsDefinition = {\n  name: 'Tabs',${field}\n};\n`;
  assert.deepEqual(adapterDomBindingWiringIssues(tabs, wired), []);
  assert.equal(adapterDomBindingWiringIssues(tabs, wired.replace(field, "")).length, 1);
  assert.equal(adapterDomBindingWiringIssues(tabs, wired.replace(importLine, "")).length, 1);
  assert.equal(adapterDomBindingWiringIssues(tabs, wired.replace('"trigger"', '"item"')).length, 1);
  assert.equal(adapterDomBindingWiringIssues(badge, wired).length, 1);
});

test("the shared installers fail the check when they name a primitive", () => {
  const primitives = catalog.primitives;
  const installers = readFileSync(new URL("../uifn/dom/src/adapter-bindings.ts", import.meta.url), "utf8");
  assert.deepEqual(sharedAdapterInstallerIssues(installers, primitives), []);
  assert.deepEqual(sharedAdapterInstallerIssues("if (bridge.definition.name === 'Menubar') focus();", primitives), [
    "uifn/dom/src/adapter-bindings.ts names the Menubar primitive",
  ]);
});
