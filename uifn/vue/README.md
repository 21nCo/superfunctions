# @uifn/vue

Accessible, unstyled Vue composables built on `@uifn/core` primitives.

## Installation

```bash
npm install @uifn/vue
```

## Usage

```vue
<script setup>
import { useCheckbox } from "@uifn/vue";

const { checked, toggle } = useCheckbox({
  defaultChecked: false,
});
</script>

<template>
  <button @click="toggle">
    {{ checked ? "Checked" : "Unchecked" }}
  </button>
</template>
```

## Composables

- useAccordion
- useCheckbox
- useDialog
- useRadioGroup
- useSwitch
- And more...

## Features

- **Accessible**: WCAG 2.1 Level AA compliant with full keyboard navigation
- **Unstyled**: No styling opinions, use with any CSS solution
- **Composable**: Vue 3 Composition API
- **TypeScript**: Full type definitions included
- **Controllable**: Both controlled and uncontrolled modes supported

## Documentation

For detailed documentation and examples, visit the [UIFn documentation](https://github.com/21nCo/super-functions/tree/main/uifn).

## License

Apache-2.0
