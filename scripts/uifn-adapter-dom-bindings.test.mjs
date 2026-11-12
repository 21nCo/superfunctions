import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { adapterDomBindings, adapterDomBindingsSource } from "./uifn-adapter-dom-bindings.mjs";

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

test("a primitive without DOM bindings gets no import and no definition field", () => {
  assert.deepEqual(adapterDomBindingsSource({ name: "Badge", behaviorFamily: "display" }, "../internal/dom-bindings"), { importLine: "", field: "" });
  assert.deepEqual(adapterDomBindingsSource({ name: "NavigationMenu", behaviorFamily: "menu-navigation" }, "./x.js"), {
    importLine: "import { navigationMenuDomBinding, rovingFocusDomBinding } from './x.js';\n",
    field: "\n  domBindings: [navigationMenuDomBinding, rovingFocusDomBinding],",
  });
});
