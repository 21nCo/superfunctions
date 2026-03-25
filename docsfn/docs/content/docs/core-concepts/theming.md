---
title: Theming
description: docsfn theme configuration, CSS custom properties, Tailwind, and dark mode.
---

# Theming

docsfn themes are plain **`ThemeConfig`** objects: colors, fonts, spacing, and a **`darkMode`** strategy. **`generateThemeCSS`** turns that config into **`:root`** declarations using the **`--docsfn-*`** custom property namespace.

See also: [Configuration](./configuration).

## CSS custom properties (`--docsfn-*`)

`generateThemeCSS` emits variables **only for keys you set**. Supported outputs today:

| Token | CSS variable |
| --- | --- |
| `colors.primary` | `--docsfn-primary` |
| `colors.secondary` | `--docsfn-secondary` |
| `colors.background` | `--docsfn-background` |
| `colors.foreground` | `--docsfn-foreground` |
| `colors.muted` | `--docsfn-muted` |
| `colors.accent` | `--docsfn-accent` |
| `colors.border` | `--docsfn-border` |
| `fonts.sans` | `--docsfn-font-sans` |
| `fonts.mono` | `--docsfn-font-mono` |
| `spacing.container` | `--docsfn-container` |
| `spacing.section` | `--docsfn-section` |

**Note:** `ThemeConfig.colors.destructive` is a valid config field for your own UI, but **`generateThemeCSS` does not yet emit** a `--docsfn-destructive` variable. Set it manually in CSS if needed.

## `ThemeConfig` structure

```ts
type DarkModeStrategy = "class" | "media" | false;

interface ThemeConfig {
  colors?: {
    primary?: string;
    secondary?: string;
    background?: string;
    foreground?: string;
    muted?: string;
    accent?: string;
    destructive?: string;
    border?: string;
  };
  fonts?: {
    sans?: string;
    mono?: string;
  };
  spacing?: {
    container?: string;
    section?: string;
  };
  darkMode?: DarkModeStrategy;
}
```

## Default presets

Core exports:

- **`defaultLightTheme`** — light surfaces, `darkMode: "class"`.
- **`defaultDarkTheme`** — dark surfaces, `darkMode: "class"`.

Use them as starting points and override individual keys.

## Overriding in CSS

Because tokens are ordinary custom properties, you can override them in global CSS:

```css
:root {
  --docsfn-primary: hsl(220 90% 56%);
  --docsfn-border: hsl(214 32% 91%);
}
```

For dark mode with **`darkMode: "class"`**, scope overrides under `.dark` (or your root dark class) in your app.

## Tailwind integration

Map docsfn tokens in `tailwind.config` (v4 theme or `@theme`) so utilities align with components:

```js
// Example: tailwind v3-style extension (adapt for v4 @theme as needed)
theme: {
  extend: {
    colors: {
      primary: "var(--docsfn-primary)",
      background: "var(--docsfn-background)",
    },
    fontFamily: {
      sans: ["var(--docsfn-font-sans)", "system-ui", "sans-serif"],
      mono: ["var(--docsfn-font-mono)", "ui-monospace", "monospace"],
    },
    maxWidth: {
      docs: "var(--docsfn-container)",
    },
  },
},
```

## Dark mode strategies

| `darkMode` | Behavior |
| --- | --- |
| `"class"` | You toggle a class on `<html>` or `<body>`; pair with CSS overrides for dark palettes. |
| `"media"` | Rely on **`prefers-color-scheme`** in your own CSS (docsfn tokens are still single `:root` unless you branch). |
| `false` | No built-in switching hook; supply static colors only. |

`defaultLightTheme` / `defaultDarkTheme` both use **`"class"`** so adapters can swap themes predictably.
