# UIFn rules

## Binding rule

UIFn is the sole shared visual system for Super Console. Tailwind is an integration mechanism for UIFn tokens and recipes, not an independent design source.

## Required packages

- `@uifn/components-svelte` for styled Svelte component compounds;
- `@uifn/theme-tailwind` for Tailwind integration;
- `@uifn/theme` and token CSS for runtime theming;
- lower-level `@uifn/svelte` only when implementing or repairing a UIFn compound.

## Prohibited patterns

- another component toolkit;
- a locally recreated button, dialog, menu, table, form control, tabs, toast, drawer, command palette, pagination, or similar shared primitive;
- hard-coded color, typography, radius, elevation, or spacing values where a UIFn semantic token exists;
- copying customer-portal panels into operator pages without an operator-specific contract;
- fixing a UIFn defect only in Super Console CSS;
- bypassing accessibility behavior owned by a UIFn primitive.

## Source-fix workflow

When a needed primitive is missing or incorrect:

1. reproduce the gap in UIFn;
2. fix the appropriate UIFn source layer;
3. add behavior, type, accessibility, and rendering coverage appropriate to the change;
4. expose it through the supported Svelte styled package;
5. run focused UIFn governance/package checks;
6. consume the fixed public API from Super Console.

Generated UIFn files are changed through their generator when repository rules require it. Generated outputs and sources remain consistent.

## Console composites

Super Console may define product composites—such as the shell, scope selector, resource page, operation form, audit receipt, run timeline, log viewer, or module health card—by composing public UIFn primitives. A composite remains console-specific and does not masquerade as a foundational primitive.

## Accessibility

- full keyboard operation and visible focus;
- semantic landmarks and headings;
- associated labels, descriptions, validation messages, and error summaries;
- accessible dialogs and destructive confirmations;
- contrast-compliant status and risk states that do not rely on color alone;
- reduced-motion support;
- announced asynchronous status where needed;
- responsive behavior without hiding required actions.

## Enforcement

Checks should reject unsupported UI dependencies and direct imports from UIFn internals. Visual and interaction tests cover representative shell, resource, action, error, empty, forbidden, and CiFn pages. UIFn package checks remain the source of truth for primitive correctness.
