# @uifn/tokens

Semantic design token schema, validation, token transforms, and OKLCH utilities for `uifn`.

This package is the source of truth for public token names and theme token validation. Runtime mounting lives in `@uifn/theme`, Tailwind integration lives in `@uifn/theme-tailwind`, and recipes live in `@uifn/recipes`.

Public tokens are semantic W3C Design Tokens-style entries such as `color.surface.canvas`, `color.text.primary`, `color.accent.solid`, `radius.md`, and `motion.easing.standard`. Cryptic public aliases and incomplete required semantic groups are rejected by validation.

Status: `ga-candidate`.

## Swift tokens

`generateSwiftTokens(themes, { name })` turns a uifn theme into one Swift source file for the `UIFnSwiftUI` library. The file declares `UIFnTheme.<name>` with colors, spacing, radius, type and motion tokens. The `uifn-swift-tokens` command does the same from theme JSON files:

```sh
npx uifn-swift-tokens --name brand \
  --light brand-light.json --dark brand-dark.json \
  [--high-contrast-light brand-hc-light.json] [--high-contrast-dark brand-hc-dark.json] \
  --import UIFnSwiftUI --out Sources/App/UIFnTheme+Brand.swift
```

- Only the light theme is required. Missing appearances fall back: dark and high-contrast light use the light theme, and high-contrast dark uses the dark theme if there is one, otherwise high-contrast light. Each theme's `mode`, when set, must match its slot.
- Each theme is checked with `validateTokenTheme`, and token references are resolved. Swift also needs every `space`, `typography.size`, `typography.lineHeight` and `typography.weight` token. Non-color tokens must be the same in every appearance, and every appearance must define the same colors.
- Colors are converted from OKLCH (or hex) to both Display P3 and sRGB. Each is gamut-mapped into its own gamut with the CSS Color 4 algorithm, which lowers chroma instead of clipping channels. In Swift, each color is a dynamic platform color that switches on light or dark, increased contrast and, on UIKit, display gamut.
- Dimensions in `px` or `rem` become points (1rem = 16pt). Each type size also maps to the Dynamic Type text style with the nearest default size (ties go to the larger style), so it scales with the user's text size.
- `--check` exits 1 without writing when the file is out of date. Use it in CI to catch generated files that no longer match their themes.

Inside this repository, `node uifn/swift/scripts/generate-tokens.mjs` regenerates the default theme's committed `UIFnTheme.uifn` file and the consumer test fixture. CI fails if that leaves a diff.
