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
- Each theme is checked with `validateTokenTheme`, and token references are resolved. Any spacing, typography or other foundation token a theme omits takes its value from `createFoundationalTokens()`, the defaults the web theme provider uses; tokens the theme supplies are kept.
- Spacing, radius, type size, line height, font weight and motion tokens must have the same value in Swift in every appearance; they are compared after conversion, so `6px` matches `0.375rem` and `120ms` matches `0.12s`. Every appearance must define the same colors. Tokens Swift does not emit, such as font families and shadows, may differ.
- The custom tone is optional, and so is each of its colors: `UIFnColors.custom` is `nil` when the theme defines no `color.custom` token, and each `UIFnCustomColors` member is `nil` when the theme omits it.
- A theme `validateTokenTheme` accepts generates unless a value has no Swift equivalent. The generator rejects, with the token path: colors other than OKLCH or hex; dimensions other than non-negative `px` or `rem`; durations, including reduced-motion values, other than `ms` or `s`; easings other than `cubic-bezier()` with x values in 0...1; negative line heights; font weights outside 1...1000; and numbers that are not finite, such as `1e400`.
- Colors are converted from OKLCH (or hex) to both Display P3 and sRGB. Each is gamut-mapped into its own gamut with the CSS Color 4 algorithm, which lowers chroma instead of clipping channels. In Swift, each color is a dynamic platform color that switches on light or dark and increased contrast. On UIKit, sRGB displays get the gamut-mapped sRGB value. On macOS, colors always use the Display P3 value and AppKit color-matches it to the screen, so an sRGB screen shows ColorSync's mapping rather than the CSS Color 4 one.
- Dimensions in `px` or `rem` become points (1rem = 16pt). Each type size also maps to the Dynamic Type text style with the nearest default size (ties go to the larger style), so it scales with the user's text size. In Swift, `UIFnTypeSize.font(weight:dynamicTypeSize:)` and the `uifnFont(_:weight:)` view modifier render the theme's points at the default text size and scale them like that text style; macOS has no Dynamic Type, so there fonts keep the theme's points.
- `--name` must be a Swift identifier other than `_`, `Type` or `Protocol`. The generated property is backticked, so keywords such as `default` work.
- `--check` exits 1 without writing when the file is out of date. Use it in CI to catch generated files that no longer match their themes.

Inside this repository, `node uifn/swift/scripts/generate-tokens.mjs` regenerates the default theme's committed `UIFnTheme.uifn` file and the consumer test fixture. CI fails if that leaves a diff.
