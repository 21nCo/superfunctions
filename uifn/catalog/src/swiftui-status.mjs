// SwiftUI status for each catalog primitive: what a SwiftUI app uses for it.
//
// This source sits beside catalog-source.mjs rather than inside it, so the
// catalog's source and catalog hashes, which the stable adapters' evidence and
// the signed registry pin, do not change when SwiftUI coverage does. The
// compiler checks it against the catalog's primitive names and writes it to
// generated/swiftui-status.json.

export const SWIFTUI_STATUS_SCHEMA_VERSION = 1;

// native: a SwiftUI control or modifier as the system draws it.
// uifn-style: a SwiftUI control drawn with a UIFnSwiftUI style, a type that
//   conforms to a SwiftUI style protocol such as ButtonStyle.
// uifn-component: a UIFnSwiftUI view or view modifier, including a view that
//   stands in for a system control, such as UIFnSegmentedPicker.
// none: neither SwiftUI nor UIFnSwiftUI has one.
export const SWIFTUI_STATUSES = ['native', 'uifn-style', 'uifn-component', 'none'];

export const SWIFTUI_SURFACE_KINDS = ['style', 'component'];

export const SWIFTUI_SOURCES_ROOT = 'uifn/swift/Sources/UIFnSwiftUI';

const styles = `${SWIFTUI_SOURCES_ROOT}/Styles`;
const components = `${SWIFTUI_SOURCES_ROOT}/Components`;

// Every public style and component UIFnSwiftUI declares. A surface's kind
// follows its declaration, not its directory: a style conforms to a SwiftUI
// style protocol; a component is a View (or a protocol refining View, such as
// Shape or a view representable), a ViewModifier or a View-extension
// function. Files in subdirectories of Styles and Components count too. The verify script checks this list, kinds included, against the
// Swift sources, so a new style or component has to be listed here and mapped
// to a primitive below.
export const SWIFTUI_SURFACES = [
  { id: 'UIFnButtonStyle', kind: 'style', issue: 'UIF-24', source: `${styles}/UIFnButtonStyle.swift` },
  { id: 'UIFnSwitchToggleStyle', kind: 'style', issue: 'UIF-24', source: `${styles}/UIFnToggleStyles.swift` },
  { id: 'UIFnCheckboxToggleStyle', kind: 'style', issue: 'UIF-24', source: `${styles}/UIFnToggleStyles.swift` },
  { id: 'UIFnTextFieldStyle', kind: 'style', issue: 'UIF-24', source: `${styles}/UIFnTextFieldStyle.swift` },
  { id: 'UIFnGroupBoxStyle', kind: 'style', issue: 'UIF-24', source: `${styles}/UIFnGroupBoxStyle.swift` },
  { id: 'UIFnMenuStyle', kind: 'style', issue: 'UIF-25', source: `${styles}/UIFnMenuStyle.swift` },
  { id: 'UIFnMenuPicker', kind: 'component', issue: 'UIF-25', source: `${styles}/UIFnPickers.swift` },
  { id: 'UIFnSegmentedPicker', kind: 'component', issue: 'UIF-25', source: `${styles}/UIFnPickers.swift` },
  { id: 'UIFnProgressViewStyle', kind: 'style', issue: 'UIF-25', source: `${styles}/UIFnProgressViewStyle.swift` },
  { id: 'UIFnGaugeStyle', kind: 'style', issue: 'UIF-25', source: `${styles}/UIFnGaugeStyle.swift` },
  { id: 'UIFnSegmentedMeter', kind: 'component', issue: 'UIF-26', source: `${components}/UIFnSegmentedMeter.swift` },
  { id: 'UIFnBanner', kind: 'component', issue: 'UIF-26', source: `${components}/UIFnBanner.swift` },
  { id: 'uifnToast', kind: 'component', issue: 'UIF-26', source: `${components}/UIFnBanner.swift` },
  { id: 'UIFnEmptyState', kind: 'component', issue: 'UIF-26', source: `${components}/UIFnEmptyState.swift` },
  { id: 'UIFnSkeleton', kind: 'component', issue: 'UIF-26', source: `${components}/UIFnSkeleton.swift` },
  { id: 'UIFnSkeletonBlock', kind: 'component', issue: 'UIF-26', source: `${components}/UIFnSkeleton.swift` },
];

function native(controls, note, surfaces = []) {
  return { status: 'native', controls, surfaces, note };
}

function styled(controls, surfaces, note) {
  return { status: 'uifn-style', controls, surfaces, note };
}

function component(surfaces, note, controls = []) {
  return { status: 'uifn-component', controls, surfaces, note };
}

function none(note) {
  return { status: 'none', controls: [], surfaces: [], note };
}

// Keyed by catalog primitive name. `controls` names the SwiftUI views and
// modifiers involved; `surfaces` names the UIFnSwiftUI styles and components,
// including ones that cover only a part of the primitive.
export const SWIFTUI_PRIMITIVES = {
  Accordion: native(['DisclosureGroup'], 'A stack of DisclosureGroup views, one per item. Whether more than one item can be open is up to the app.'),
  AlertDialog: native(['.alert', '.confirmationDialog'], 'The system alert or confirmation dialog, with a button in the cancel role.'),
  AngleSlider: none('SwiftUI has no rotary slider, and UIFnSwiftUI has no angle control.'),
  Autocomplete: native(['.searchable', '.searchSuggestions'], 'Suggestions under a search field; UIFnEmptyState can show the empty part when nothing matches. SwiftUI offers no suggestions for a plain text field.', ['UIFnEmptyState']),
  Avatar: none('SwiftUI has no avatar view, and UIFnSwiftUI has none either.'),
  Button: styled(['Button'], ['UIFnButtonStyle'], 'Button with .uifnPrimary, .uifnSecondary, .uifnGhost or .uifnDestructive.'),
  Carousel: none('TabView pages only on iOS (.page style), so there is no carousel on both platforms, and UIFnSwiftUI has none.'),
  Checkbox: styled(['Toggle'], ['UIFnCheckboxToggleStyle'], 'Toggle with .uifnCheckbox.'),
  CheckboxGroup: styled(['Toggle'], ['UIFnCheckboxToggleStyle'], 'A group of .uifnCheckbox toggles; a parent Toggle(sources:isOn:) shows the mixed state.'),
  Clipboard: styled(['Button'], ['UIFnButtonStyle', 'uifnToast'], 'A uifn-styled Button that writes to the pasteboard, with uifnToast to confirm the copy. SwiftUI has no copy control.'),
  Collapsible: native(['DisclosureGroup'], 'A DisclosureGroup.'),
  ColorPicker: native(['ColorPicker'], 'The system ColorPicker.'),
  Combobox: none('SwiftUI has no editable combo box. For a choice without typing, see Select.'),
  ContextMenu: native(['.contextMenu'], 'The system context menu.'),
  DateInput: native(['DatePicker'], 'DatePicker with the .field style on macOS or .compact on iOS.'),
  DatePicker: native(['DatePicker'], 'DatePicker with the .graphical style.'),
  Dialog: native(['.sheet'], 'A sheet.'),
  Drawer: native(['.sheet', '.presentationDetents'], 'A sheet with detents on iOS; macOS sheets have no detents.'),
  Editable: none('SwiftUI has no inline-edit control; an app swaps Text for a TextField itself.'),
  Field: native(['LabeledContent'], 'LabeledContent pairs a label with its control; the description and error text are up to the app.'),
  Fieldset: styled(['GroupBox'], ['UIFnGroupBoxStyle'], 'GroupBox with the .uifn style, titled with the legend. Inside a Form, a Section instead.'),
  FileUpload: native(['.fileImporter', '.dropDestination'], 'The system file importer, with drop support where the app adds it.'),
  FloatingPanel: none('SwiftUI has no floating panel on iOS 16 or macOS 13.'),
  Form: native(['Form'], 'The system Form.'),
  HoverCard: none('SwiftUI has no hover card; .help shows only text.'),
  ImageCropper: none('SwiftUI has no image cropper.'),
  Input: styled(['TextField'], ['UIFnTextFieldStyle'], 'TextField with the .uifn style.'),
  Listbox: native(['List'], 'A List with a selection binding.'),
  Marquee: none('SwiftUI has no marquee.'),
  Menu: styled(['Menu'], ['UIFnMenuStyle'], 'Menu with the .uifn style, which draws its label; the items stay the system menu\'s.'),
  Menubar: native(['CommandMenu'], 'Commands in the macOS menu bar; iOS has no menu bar.'),
  Meter: styled(['Gauge'], ['UIFnGaugeStyle', 'UIFnSegmentedMeter'], 'Gauge with .uifnLinear or .uifnCircular; UIFnSegmentedMeter draws a meter in segments.'),
  NavigationMenu: native(['NavigationSplitView', 'NavigationLink'], 'A NavigationSplitView sidebar of NavigationLink rows.'),
  NumberInput: styled(['TextField', 'Stepper'], ['UIFnTextFieldStyle'], 'A TextField with a number format in the .uifn style, beside a system Stepper.'),
  Pagination: none('SwiftUI has no pagination control.'),
  PasswordInput: native(['SecureField'], 'SecureField as the system draws it; UIFnSwiftUI tests its text field style only on TextField.'),
  PinInput: none('SwiftUI has no one-time-code input.'),
  Popover: native(['.popover'], 'The system popover.'),
  Progress: styled(['ProgressView'], ['UIFnProgressViewStyle'], 'ProgressView with .uifnLinear or .uifnCircular.'),
  QRCode: none('SwiftUI draws no QR codes, and UIFnSwiftUI has no QR view.'),
  RadioGroup: native(['Picker'], 'Picker with the .radioGroup style on macOS or .inline on iOS; UIFnSwiftUI has no radio style.'),
  RatingGroup: none('SwiftUI has no rating control.'),
  ScrollArea: native(['ScrollView'], 'A ScrollView.'),
  SegmentGroup: component(['UIFnSegmentedPicker'], 'UIFnSegmentedPicker with the .segmented variant, a UIFnSwiftUI view that draws the segments; accessibility sees a system segmented Picker.', ['Picker']),
  Select: component(['UIFnMenuPicker', 'UIFnMenuStyle'], 'UIFnMenuPicker, a UIFnSwiftUI view: a system Picker inside a .uifn menu.', ['Picker', 'Menu']),
  Separator: native(['Divider'], 'A Divider.'),
  SignaturePad: none('SwiftUI has no drawing canvas for signatures.'),
  Slider: native(['Slider'], 'The system Slider; SwiftUI has no public slider style.'),
  Splitter: native(['HSplitView', 'VSplitView'], 'Split views on macOS; iOS has no resizable split, only NavigationSplitView columns.'),
  Steps: none('SwiftUI has no step indicator.'),
  Switch: styled(['Toggle'], ['UIFnSwitchToggleStyle'], 'Toggle with .uifnSwitch.'),
  Tabs: component(['UIFnSegmentedPicker'], 'UIFnSegmentedPicker with the .tabs variant, which switches content in place. For app sections, TabView.', ['Picker']),
  TagsInput: none('SwiftUI shows tokens only in a search field (.searchable with tokens), not in a general input.'),
  Timer: native(['Text', 'TimelineView'], 'Text(timerInterval:) counts up or down; start, pause and reset are up to the app.'),
  Toast: component(['uifnToast', 'UIFnBanner'], 'uifnToast shows a UIFnBanner at the edge of a view and announces it.'),
  Toggle: native(['Toggle'], 'Toggle with the .button style; UIFnSwiftUI has no pressed-button toggle style.'),
  ToggleGroup: native(['ControlGroup', 'Toggle'], 'Button-style toggles in a ControlGroup. For a single choice, see SegmentGroup.'),
  Toolbar: native(['.toolbar', 'ToolbarItem'], 'The system toolbar.'),
  Tooltip: native(['.help'], 'Help text, which macOS shows as a tooltip.'),
  Tour: none('SwiftUI has no guided tour on iOS 16 or macOS 13.'),
  TreeView: native(['List', 'OutlineGroup'], 'A List with children, or an OutlineGroup.'),
  Badge: native(['.badge'], 'Badges on list rows and tab items; UIFnSwiftUI has no badge view.'),
  Breadcrumb: none('SwiftUI has no breadcrumb.'),
  Card: styled(['GroupBox'], ['UIFnGroupBoxStyle'], 'GroupBox with the .uifn style.'),
  Command: native(['List', '.searchable'], 'A searchable List of commands; UIFnEmptyState can show the empty part. SwiftUI has no command palette.', ['UIFnEmptyState']),
  InputGroup: none('SwiftUI has no input group; a .uifn TextField beside its addons draws no shared border.'),
  Skeleton: component(['UIFnSkeleton', 'UIFnSkeletonBlock'], 'UIFnSkeleton around UIFnSkeletonBlock shapes.'),
  Table: native(['Table'], 'The system Table.'),
  Textarea: native(['TextEditor'], 'TextEditor; UIFnSwiftUI has no text editor style.'),
};

export const SWIFTUI_STATUS_SOURCE = {
  schemaVersion: SWIFTUI_STATUS_SCHEMA_VERSION,
  statuses: [...SWIFTUI_STATUSES],
  surfaces: SWIFTUI_SURFACES,
  primitives: SWIFTUI_PRIMITIVES,
};
