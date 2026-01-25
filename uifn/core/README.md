# @uifn/core

Framework-agnostic UI primitives and utilities for building accessible, unstyled component libraries.

## Overview

`@uifn/core` provides the foundational logic for UI components without any framework-specific code. It includes:

- **Primitives**: Core state management and behavior for UI components
- **Utils**: Shared utilities (focus management, ID generation, positioning)
- **ARIA**: Accessibility helpers and patterns
- **State**: State machines for complex component behavior

## Installation

```bash
npm install @uifn/core
```

## Usage

This package is typically used as a dependency by framework-specific adapters like `@uifn/react`, `@uifn/vue`, or `@uifn/svelte`. However, you can use it directly:

```typescript
import { createCheckbox } from "@uifn/core/primitives/checkbox";
import { generateId } from "@uifn/core/utils/id";

const checkbox = createCheckbox({
  defaultChecked: false,
  onCheckedChange: (checked) => {
    console.log("Checked:", checked);
  },
});

// Subscribe to state changes
checkbox.subscribe((state) => {
  console.log("State:", state);
});

// Toggle the checkbox
checkbox.actions.toggle();
```

## Framework Adapters

- **React**: `@uifn/react`
- **Vue**: `@uifn/vue`
- **Svelte**: `@uifn/svelte`

## License

Apache-2.0
