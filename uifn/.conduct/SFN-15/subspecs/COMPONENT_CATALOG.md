# Sub-spec: Component and Hook Catalog

## Purpose

Define the full Coss UI capability target for clean-room `uifn` components and hooks.

## Catalog Snapshot

Source snapshot: `https://coss.com/ui/docs`, observed 2026-06-27.

`uifn` MUST provide the following base components:

| Component | Category | Primitive-backed | Styled component required | Registry required |
| --- | --- | --- | --- | --- |
| Accordion | Disclosure | yes | yes | yes |
| Alert Dialog | Overlay | yes | yes | yes |
| Aspect Ratio | Layout | optional | yes | yes |
| Avatar | Display | yes | yes | yes |
| Badge | Display | no | yes | yes |
| Breadcrumb | Navigation | optional | yes | yes |
| Button | Action | no | yes | yes |
| Calendar | Date/time | yes | yes | yes |
| Card | Layout | no | yes | yes |
| Checkbox | Form | yes | yes | yes |
| Collapsible | Disclosure | yes | yes | yes |
| Command | Command/search | yes | yes | yes |
| Context Menu | Overlay/menu | yes | yes | yes |
| Data Table | Data | yes | yes | yes |
| Date Picker | Date/time | yes | yes | yes |
| Dialog | Overlay | yes | yes | yes |
| Dropdown Menu | Overlay/menu | yes | yes | yes |
| Form | Form | yes | yes | yes |
| Hover Card | Overlay | yes | yes | yes |
| Input | Form | no | yes | yes |
| Input OTP | Form | yes | yes | yes |
| Label | Form | no | yes | yes |
| Menubar | Navigation/menu | yes | yes | yes |
| Pagination | Navigation | yes | yes | yes |
| Popover | Overlay | yes | yes | yes |
| Progress | Feedback | yes | yes | yes |
| Radio Group | Form | yes | yes | yes |
| Resizable | Layout | yes | yes | yes |
| Scroll Area | Layout | yes | yes | yes |
| Select | Form | yes | yes | yes |
| Separator | Layout | no | yes | yes |
| Sheet | Overlay | yes | yes | yes |
| Sidebar | Navigation/layout | yes | yes | yes |
| Skeleton | Feedback | no | yes | yes |
| Slider | Form | yes | yes | yes |
| Sonner | Feedback/toast | yes | yes | yes |
| Switch | Form | yes | yes | yes |
| Table | Data/display | optional | yes | yes |
| Tabs | Navigation | yes | yes | yes |
| Textarea | Form | no | yes | yes |
| Toast | Feedback | yes | yes | yes |
| Toggle | Action | yes | yes | yes |
| Toggle Group | Action | yes | yes | yes |
| Tooltip | Overlay | yes | yes | yes |
| Typography | Content | no | yes | yes |

`uifn` MUST provide the following hook equivalents:

| Hook | Framework mapping |
| --- | --- |
| `useMediaQuery` | React hook, Svelte readable/action, Vue composable, Solid signal helper, Angular service/directive |
| `useCopyToClipboard` | React hook, Svelte action/helper, Vue composable, Solid helper, Angular service/directive |

## Required Component Metadata

Each component manifest MUST include:

- canonical name,
- category,
- kind,
- support status,
- framework support,
- primitive dependencies,
- recipe dependencies,
- token groups used,
- stories,
- fixtures,
- tests,
- registry files,
- package imports,
- source policy.

## Required Story Coverage

Each component MUST include stories for:

- default,
- variants,
- sizes,
- states,
- disabled/readonly where applicable,
- invalid/error where applicable,
- loading/empty where applicable,
- keyboard flow for interactive components,
- light/dark/high-contrast themes,
- responsive behavior where applicable.

## Data-Rich Component Details

Data Table MUST specify sorting, filtering, pagination, selection, column visibility, row actions, loading, empty, error, and virtualization behavior.

Calendar and Date Picker MUST specify locale, timezone display policy, min/max, disabled dates, range mode where supported, keyboard navigation, and form integration.

Command MUST specify filtering, grouping, empty state, keyboard loop behavior, item disabled state, async loading state, and large list behavior.

Sidebar MUST specify collapsed state, responsive mode, focus behavior, persistent state hooks, and nested navigation semantics.

Resizable MUST specify pointer behavior, keyboard behavior, min/max constraints, orientation, and nested panel rules.

