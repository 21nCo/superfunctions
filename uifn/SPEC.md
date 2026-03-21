# UIFn Primitives Specification

## Overview

UIFn Primitives is a framework-agnostic library of unstyled, accessible UI components centered on a shared core plus framework adapters. Inspired by Radix UI, these primitives provide the foundation for building design systems and component libraries.

## Phase 0 Release Contract Baseline (2026-03-20)

This section is normative for package identity, support claims, and compatibility in the current release train.

### Canonical package identities

- `@uifn/core` (GA)
- `@uifn/react` (GA)
- `@uifn/svelte` (GA)
- `@uifn/vue` (Experimental)
- `@uifn/files` (Experimental)

No deprecated `uifn` alias is published for core in this baseline.

### Support claims

- Unsupported adapters such as Solid and web-components are not part of the current supported matrix.
- Vue is public but experimental; docs must match shipped API shape.
- Files is public but experimental; docs and pack output must remain explicit and clean.

### Display-helper contract baseline

- `Avatar`, `Badge`, `Label`, and `Separator` are GA when consumed from `@uifn/react` and `@uifn/svelte`.
- The same families are Experimental in `@uifn/vue` because the Vue adapter itself is Experimental.
- `VirtualizedList` is adapter-only (not part of `@uifn/core`) and currently shipped by React and Svelte adapters.
- Avatar fallback behavior must remain deterministic: fallback appears on image error/missing source and respects optional delay configuration.
- Virtualized list behavior must remain deterministic: `overscan` defaults to `3` and item rendering follows adapter contracts (`renderItem` in React, snippet children in Svelte).

### Compatibility matrix

- Node.js: `18.x`, `20.x`, `22.x`
- React: `18.2+`
- Svelte: `5.x`
- Vue (experimental): `3.5+`
- Browsers: current evergreen Chrome, Edge, Firefox, Safari

### Release-gate command

- Command: `npm run verify:uifn-release`
- Dry run: `npm run verify:uifn-release -- --dry-run`
- Gate checks: build, lint, test, type, export-map, pack verification for all public `uifn` packages.

## Core Principles

### 1. Framework Agnostic

- Core logic implemented in vanilla JavaScript/TypeScript
- Framework-specific adapters provided for React and Svelte (GA), plus Vue (experimental)
- Minimal dependencies to reduce bundle size
- Pure functions and state machines where possible

### 2. Accessibility First

- WCAG 2.1 Level AA compliance by default
- Full keyboard navigation support
- Screen reader announcements via ARIA
- Focus management and trapping
- Respect for user preferences (prefers-reduced-motion, prefers-color-scheme)

### 3. Unstyled by Default

- Zero styling opinions
- Composable parts with data attributes for styling hooks
- CSS-in-JS, Tailwind, CSS Modules, or plain CSS compatible
- Design tokens can be applied at implementation level

### 4. Composable Architecture

- Small, focused primitives that do one thing well
- Compound components pattern for complex UI
- Explicit prop APIs over implicit behavior
- Controllable and uncontrollable modes

### 5. Developer Experience

- TypeScript-first with comprehensive type definitions
- Intuitive API design following platform conventions
- Rich documentation with examples
- Minimal learning curve for framework users

## Architecture

### Core Layer

```
core/
├── state/           # State machines and reducers
├── utils/           # Shared utilities (focus management, ID generation, etc.)
├── hooks/           # Framework-agnostic logic hooks
├── aria/            # ARIA patterns and helpers
└── primitives/      # Core primitive implementations
```

### Framework Adapters

```
adapters/
├── react/
├── vue/
└── svelte/
```

### State Management

- Use state machines (XState-inspired) for complex components
- Immutable state updates
- Event-driven architecture
- Support for both controlled and uncontrolled modes

### Event System

- Custom event system for cross-framework compatibility
- Bubble and capture phases
- Event composition and delegation
- Prevention and stopPropagation support

## Primitive Components

### 1. Accordion

**Purpose**: Vertically stacked set of interactive headings that reveal/hide associated content.

**Parts**:

- `Accordion` - Root container
- `AccordionItem` - Individual accordion item
- `AccordionTrigger` - Button to toggle item
- `AccordionContent` - Collapsible content region

**Features**:

- Single or multiple items open simultaneously
- Controlled/uncontrolled value state
- Keyboard navigation (Arrow Up/Down, Home, End)
- ARIA: `role="region"`, `aria-expanded`, `aria-controls`

**State**:

```typescript
interface AccordionState {
  value: string | string[];
  type: "single" | "multiple";
  collapsible: boolean;
  disabled: boolean;
}
```

**Events**:

- `onValueChange(value: string | string[])`

---

### 2. Alert Dialog

**Purpose**: Modal dialog that interrupts the user with important content requiring response.

**Parts**:

- `AlertDialog` - Root context provider
- `AlertDialogTrigger` - Opens the dialog
- `AlertDialogPortal` - Portal for rendering outside DOM hierarchy
- `AlertDialogOverlay` - Background overlay
- `AlertDialogContent` - Dialog content container
- `AlertDialogTitle` - Accessible dialog title
- `AlertDialogDescription` - Dialog description
- `AlertDialogAction` - Primary action button
- `AlertDialogCancel` - Cancel button

**Features**:

- Focus trapping within dialog
- Focus return to trigger on close
- Escape key to close (with cancel action)
- Click outside to close (optional)
- Prevent body scroll when open
- ARIA: `role="alertdialog"`, `aria-labelledby`, `aria-describedby`

**State**:

```typescript
interface AlertDialogState {
  open: boolean;
  returnFocus: boolean;
  closeOnEsc: boolean;
  closeOnOutsideClick: boolean;
}
```

---

### 3. Checkbox

**Purpose**: Control for toggling between checked and unchecked states.

**Parts**:

- `Checkbox` - Root checkbox element
- `CheckboxIndicator` - Visual indicator (checkmark)

**Features**:

- Controlled/uncontrolled checked state
- Indeterminate state support
- Form integration with name/value
- Keyboard support (Space to toggle)
- ARIA: `role="checkbox"`, `aria-checked`

**State**:

```typescript
interface CheckboxState {
  checked: boolean | "indeterminate";
  disabled: boolean;
  required: boolean;
  name?: string;
  value?: string;
}
```

---

### 4. Collapsible

**Purpose**: Interactive component to show/hide content.

**Parts**:

- `Collapsible` - Root container
- `CollapsibleTrigger` - Toggle button
- `CollapsibleContent` - Expandable content region

**Features**:

- Controlled/uncontrolled open state
- Animation-ready with data attributes
- Keyboard support
- ARIA: `aria-expanded`, `aria-controls`

**State**:

```typescript
interface CollapsibleState {
  open: boolean;
  disabled: boolean;
}
```

---

### 5. Combobox

**Purpose**: Combined input and listbox for filtering and selecting from options.

**Parts**:

- `Combobox` - Root container
- `ComboboxTrigger` - Button to open dropdown
- `ComboboxInput` - Text input for filtering
- `ComboboxContent` - Dropdown container
- `ComboboxViewport` - Scrollable list area
- `ComboboxItem` - Individual option
- `ComboboxItemIndicator` - Selected state indicator
- `ComboboxEmpty` - Empty state message
- `ComboboxGroup` - Grouped options
- `ComboboxLabel` - Group label

**Features**:

- Typeahead filtering
- Keyboard navigation (Arrow keys, Home, End, Enter, Escape)
- Single/multiple selection
- Virtual scrolling for large lists
- Custom filtering logic
- ARIA: `role="combobox"`, `aria-expanded`, `aria-autocomplete`, `aria-activedescendant`

**State**:

```typescript
interface ComboboxState {
  open: boolean;
  value: string | string[];
  inputValue: string;
  highlightedIndex: number;
  multiple: boolean;
  filter: (items: any[], query: string) => any[];
}
```

---

### 6. Context Menu

**Purpose**: Menu displayed on right-click or long-press.

**Parts**:

- `ContextMenu` - Root context provider
- `ContextMenuTrigger` - Area to trigger menu
- `ContextMenuContent` - Menu container
- `ContextMenuItem` - Individual menu item
- `ContextMenuCheckboxItem` - Checkable menu item
- `ContextMenuRadioGroup` - Radio group container
- `ContextMenuRadioItem` - Radio menu item
- `ContextMenuSub` - Submenu container
- `ContextMenuSubTrigger` - Submenu trigger
- `ContextMenuSubContent` - Submenu content
- `ContextMenuSeparator` - Visual separator
- `ContextMenuLabel` - Non-interactive label

**Features**:

- Right-click and long-press support
- Keyboard navigation
- Nested submenus
- Checkboxes and radio groups
- Auto-positioning to stay in viewport
- ARIA: `role="menu"`, `role="menuitem"`, `aria-haspopup`

---

### 7. Dialog

**Purpose**: Window overlaid on primary content.

**Parts**:

- `Dialog` - Root context provider
- `DialogTrigger` - Opens dialog
- `DialogPortal` - Portal for rendering
- `DialogOverlay` - Background overlay
- `DialogContent` - Dialog content
- `DialogTitle` - Accessible title
- `DialogDescription` - Dialog description
- `DialogClose` - Close button

**Features**:

- Focus trapping
- Focus return on close
- Escape to close
- Click outside to close (optional)
- Scroll locking
- Nested dialogs support
- ARIA: `role="dialog"`, `aria-modal`, `aria-labelledby`, `aria-describedby`

---

### 8. Dropdown Menu

**Purpose**: Menu triggered by a button.

**Parts**:

- Same as Context Menu (ContextMenu* → DropdownMenu*)
- `DropdownMenuTrigger` - Button to open menu

**Features**:

- Same as Context Menu
- Click/hover trigger options
- Arrow key navigation

---

### 9. Hover Card

**Purpose**: Preview content on hover.

**Parts**:

- `HoverCard` - Root container
- `HoverCardTrigger` - Element to hover
- `HoverCardContent` - Preview content
- `HoverCardArrow` - Optional arrow pointer

**Features**:

- Configurable open/close delays
- Auto-positioning
- Keyboard accessible (focus trigger)
- Mouse leave delay
- ARIA: `aria-expanded`

**State**:

```typescript
interface HoverCardState {
  open: boolean;
  openDelay: number;
  closeDelay: number;
}
```

---

### 10. Label

**Purpose**: Accessible label for form controls.

**Parts**:

- `Label` - Label element

**Features**:

- Associates with form controls via `htmlFor` or nesting
- Click to focus associated control
- ARIA support

---

### 11. Popover

**Purpose**: Floating panel anchored to an element.

**Parts**:

- `Popover` - Root container
- `PopoverTrigger` - Element to trigger
- `PopoverAnchor` - Optional positioning anchor
- `PopoverContent` - Popover content
- `PopoverClose` - Close button
- `PopoverArrow` - Optional arrow

**Features**:

- Auto-positioning with collision detection
- Click, hover, or focus trigger
- Controlled/uncontrolled open state
- Escape to close
- Click outside to close (optional)
- ARIA: `aria-expanded`, `aria-haspopup`

---

### 12. Progress

**Purpose**: Display task progress.

**Parts**:

- `Progress` - Root container
- `ProgressIndicator` - Visual progress bar

**Features**:

- Determinate and indeterminate states
- Value, max, and min support
- ARIA: `role="progressbar"`, `aria-valuenow`, `aria-valuemin`, `aria-valuemax`

**State**:

```typescript
interface ProgressState {
  value: number | null;
  max: number;
  min: number;
}
```

---

### 13. Radio Group

**Purpose**: Set of checkable buttons where only one can be checked.

**Parts**:

- `RadioGroup` - Root container
- `RadioGroupItem` - Individual radio button
- `RadioGroupIndicator` - Visual indicator

**Features**:

- Keyboard navigation (Arrow keys)
- Form integration
- Controlled/uncontrolled value
- ARIA: `role="radiogroup"`, `role="radio"`, `aria-checked`

**State**:

```typescript
interface RadioGroupState {
  value: string;
  disabled: boolean;
  required: boolean;
  name?: string;
  orientation: "horizontal" | "vertical";
}
```

---

### 14. Scroll Area

**Purpose**: Custom scrollable area with styled scrollbars.

**Parts**:

- `ScrollArea` - Root container
- `ScrollAreaViewport` - Scrollable content area
- `ScrollAreaScrollbar` - Scrollbar (horizontal/vertical)
- `ScrollAreaThumb` - Draggable scroll indicator
- `ScrollAreaCorner` - Corner where scrollbars meet

**Features**:

- Custom scrollbar styling
- Native scroll behavior
- Horizontal/vertical scrolling
- Scroll position synchronization

---

### 15. Select

**Purpose**: Display selected value from a list of options.

**Parts**:

- `Select` - Root container
- `SelectTrigger` - Button to open options
- `SelectValue` - Display selected value
- `SelectContent` - Options container
- `SelectViewport` - Scrollable area
- `SelectItem` - Individual option
- `SelectItemIndicator` - Selected indicator
- `SelectGroup` - Grouped options
- `SelectLabel` - Group label
- `SelectSeparator` - Visual separator

**Features**:

- Keyboard navigation
- Typeahead search
- Form integration
- Controlled/uncontrolled value
- Auto-positioning
- ARIA: `role="combobox"`, `aria-expanded`, `aria-activedescendant`

---

### 16. Separator

**Purpose**: Visual or semantic separator.

**Parts**:

- `Separator` - Separator element

**Features**:

- Horizontal/vertical orientation
- Decorative or semantic
- ARIA: `role="separator"` (when semantic)

---

### 17. Slider

**Purpose**: Input for selecting value(s) from a range.

**Parts**:

- `Slider` - Root container
- `SliderTrack` - Track line
- `SliderRange` - Filled range
- `SliderThumb` - Draggable handle(s)

**Features**:

- Single/multiple thumbs
- Keyboard support (Arrow keys, Home, End)
- Touch and mouse dragging
- Min, max, step values
- Vertical/horizontal orientation
- Form integration
- ARIA: `role="slider"`, `aria-valuenow`, `aria-valuemin`, `aria-valuemax`

**State**:

```typescript
interface SliderState {
  value: number[];
  min: number;
  max: number;
  step: number;
  disabled: boolean;
  orientation: "horizontal" | "vertical";
}
```

---

### 18. Switch

**Purpose**: Toggle between on and off states.

**Parts**:

- `Switch` - Root switch element
- `SwitchThumb` - Visual thumb indicator

**Features**:

- Controlled/uncontrolled checked state
- Form integration
- Keyboard support (Space to toggle)
- ARIA: `role="switch"`, `aria-checked`

**State**:

```typescript
interface SwitchState {
  checked: boolean;
  disabled: boolean;
  required: boolean;
  name?: string;
  value?: string;
}
```

---

### 19. Tabs

**Purpose**: Layered content areas accessed via tab list.

**Parts**:

- `Tabs` - Root container
- `TabsList` - Tab buttons container
- `TabsTrigger` - Individual tab button
- `TabsContent` - Tab panel content

**Features**:

- Keyboard navigation (Arrow keys, Home, End)
- Automatic/manual activation
- Controlled/uncontrolled value
- Horizontal/vertical orientation
- ARIA: `role="tablist"`, `role="tab"`, `role="tabpanel"`, `aria-selected`, `aria-controls`

**State**:

```typescript
interface TabsState {
  value: string;
  orientation: "horizontal" | "vertical";
  activationMode: "automatic" | "manual";
}
```

---

### 20. Toast

**Purpose**: Non-modal notifications.

**Parts**:

- `ToastProvider` - Context provider with viewport
- `Toast` - Individual toast notification
- `ToastTitle` - Toast title
- `ToastDescription` - Toast description
- `ToastAction` - Action button
- `ToastClose` - Close button
- `ToastViewport` - Container for all toasts

**Features**:

- Auto-dismiss with configurable duration
- Pause on hover/focus
- Swipe to dismiss
- Action buttons
- Multiple toasts with queuing
- Positioning (top-left, top-right, bottom-left, bottom-right, top-center, bottom-center)
- ARIA: `role="status"` or `role="alert"`, `aria-live`, `aria-atomic`

**State**:

```typescript
interface ToastState {
  open: boolean;
  duration: number;
  type: "foreground" | "background";
}
```

**API**:

```typescript
const toast = useToast();
toast.show({
  title: "Success",
  description: "Your changes have been saved.",
  duration: 3000,
  action: { label: "Undo", onClick: () => {} },
});
```

---

### 21. Toggle

**Purpose**: Two-state button.

**Parts**:

- `Toggle` - Toggle button element

**Features**:

- Controlled/uncontrolled pressed state
- Keyboard support (Space/Enter)
- ARIA: `aria-pressed`

**State**:

```typescript
interface ToggleState {
  pressed: boolean;
  disabled: boolean;
  required: boolean;
}
```

---

### 22. Toggle Group

**Purpose**: Group of toggle buttons with single or multiple selection.

**Parts**:

- `ToggleGroup` - Root container
- `ToggleGroupItem` - Individual toggle button

**Features**:

- Single/multiple selection modes
- Keyboard navigation
- Controlled/uncontrolled value
- ARIA: `role="group"`, `aria-pressed`

**State**:

```typescript
interface ToggleGroupState {
  type: "single" | "multiple";
  value: string | string[];
  disabled: boolean;
}
```

---

### 23. Toolbar

**Purpose**: Container for grouping buttons and controls.

**Parts**:

- `Toolbar` - Root container
- `ToolbarButton` - Button element
- `ToolbarLink` - Link element
- `ToolbarToggleGroup` - Group of toggles
- `ToolbarToggleItem` - Individual toggle
- `ToolbarSeparator` - Visual separator

**Features**:

- Keyboard navigation (Arrow keys, Home, End)
- Horizontal/vertical orientation
- ARIA: `role="toolbar"`, `aria-orientation`

---

### 24. Tooltip

**Purpose**: Popup displaying information on hover/focus.

**Parts**:

- `TooltipProvider` - Context provider with defaults
- `Tooltip` - Root container
- `TooltipTrigger` - Element to trigger tooltip
- `TooltipContent` - Tooltip content
- `TooltipArrow` - Optional arrow

**Features**:

- Hover and focus triggers
- Configurable delays
- Auto-positioning
- Keyboard accessible
- ARIA: `role="tooltip"`, `aria-describedby`

**State**:

```typescript
interface TooltipState {
  open: boolean;
  delayDuration: number;
  skipDelayDuration: number;
  disableHoverableContent: boolean;
}
```

---

## Common Patterns

### Controlled vs Uncontrolled

All stateful components support both modes:

```typescript
// Uncontrolled
<Accordion defaultValue="item-1" />

// Controlled
<Accordion value={value} onValueChange={setValue} />
```

### Composition

Components use compound pattern:

```typescript
<Dialog>
  <DialogTrigger>Open</DialogTrigger>
  <DialogContent>
    <DialogTitle>Title</DialogTitle>
    <DialogDescription>Description</DialogDescription>
  </DialogContent>
</Dialog>
```

### Data Attributes

All components expose state via data attributes:

```typescript
// Checkbox example
data-state="checked" | "unchecked" | "indeterminate"
data-disabled
data-readonly

// Accordion example
data-state="open" | "closed"
data-orientation="vertical" | "horizontal"
```

### Polymorphic Components

Allow changing the rendered element:

```typescript
<Button asChild>
  <a href="/home">Home</a>
</Button>
```

## Utilities

### Focus Management

- `FocusTrap` - Trap focus within container
- `FocusScope` - Manage focus programmatically
- `useFocusReturn` - Return focus on unmount

### Portal

- Render content outside component hierarchy
- Multiple portal targets
- Preserve context

### Presence

- Animate component enter/exit
- Wait for animations before unmount
- Integration with animation libraries

### Position

- Auto-positioning with collision detection
- Arrow positioning
- Alignment options (start, center, end)
- Side preferences (top, right, bottom, left)

### ID Generation

- Unique ID generation
- SSR-safe
- Deterministic for testing

### Roving Focus

- Manage focus within lists
- Arrow key navigation
- Home/End support
- Typeahead search

## Accessibility Features

### Keyboard Navigation

Every component implements appropriate keyboard patterns from WAI-ARIA Authoring Practices.

### Screen Reader Support

- Proper ARIA roles and attributes
- Live region announcements
- Hidden content handling
- Accessible names and descriptions

### Focus Indicators

- Visible focus indicators
- Focus-visible support
- Custom focus styling hooks

### Motion Preferences

Respect `prefers-reduced-motion`:

- Disable animations when requested
- Instant state transitions
- Maintain functionality without motion

## Testing

### Unit Tests

- Test state machines
- Test utilities in isolation
- Test accessibility helpers

### Integration Tests

- Test component composition
- Test keyboard interactions
- Test ARIA attributes

### Accessibility Tests

- Automated axe-core checks
- Screen reader testing (NVDA, JAWS, VoiceOver)
- Keyboard-only navigation testing
