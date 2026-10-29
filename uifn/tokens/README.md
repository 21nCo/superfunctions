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
- Each theme is checked with `validateTokenTheme`, and token references are resolved. Any spacing, typography or other foundation token a theme omits takes its value from `createFoundationalTokens()`; tokens the theme supplies are kept. Swift fills each omitted token individually, so a theme that defines only `typography.size.md` keeps that size and takes every other typography token from the foundations. The web theme provider fills whole top-level groups instead: a theme that supplies any `typography` token replaces the entire foundation `typography` group on the web.
- Spacing, radius, type size, line height, font weight and motion tokens must have the same value in Swift in every appearance; they are compared after conversion, so `6px` matches `0.375rem` and `120ms` matches `0.12s`. Every appearance must define the same colors. Tokens Swift does not emit, such as font families and shadows, may differ.
- The custom tone is optional, and so is each of its colors: `UIFnColors.custom` is `nil` when the theme defines no `color.custom` token, and each `UIFnCustomColors` member is `nil` when the theme omits it.
- A theme `validateTokenTheme` accepts generates unless a value has no Swift equivalent. The generator rejects, with the token path: colors other than OKLCH or hex; dimensions other than non-negative `px` or `rem`; durations, including reduced-motion values, other than non-negative `ms` or `s`; easings other than `cubic-bezier()` with x values in 0...1; negative line heights; font weights outside 1...1000; and numbers that are not finite, such as `1e400`. Amounts use CSS number syntax, so `+4px`, `4e0px` and `1.2e2ms` are the same as `4px`, `4px` and `120ms`.
- The generator also checks the theme's contrast pairs (the text and tone pairs plus each `contrastAgainst`, skipping `decorativeOnly` tokens) on the emitted sRGB and Display P3 values, exactly as written to Swift, in every appearance, and rejects a pair below 4.5:1 with `UIFN_CONTRAST_BUDGET`, naming the appearance, both token paths and the gamut. The ratio is not rounded before the comparison, so 4.498:1 fails; the reported ratio is rounded down. `validateTokenTheme` clips out-of-gamut channels, while the generator lowers chroma, so a very saturated color can pass it yet fall below the budget as emitted: `oklch(73% 0.4 275)` measures 4.53:1 against white there but 2.52:1 as emitted sRGB.
- Colors are converted from OKLCH (or hex) to both Display P3 and sRGB. Each is gamut-mapped into its own gamut with the CSS Color 4 algorithm, which lowers chroma instead of clipping channels. In Swift, each color is a dynamic platform color that switches on light or dark and increased contrast. On UIKit, sRGB displays get the gamut-mapped sRGB value. AppKit colors cannot see the screen they draw on, so on macOS the choice comes from the destination you pass: `nsColor(for: view.window?.screen)`, `nsColor(displayGamut:)` and, in SwiftUI, `color(displayGamut:)` with the `uifnDisplayGamut` environment value that `uifnDisplayGamutFromWindow()` keeps in step with the window's screen. An sRGB destination gets the gamut-mapped sRGB value and any other destination Display P3. `nsColor` and `color` without a destination are always Display P3, which AppKit color-matches with ColorSync on an sRGB screen.
- Dimensions in `px` or `rem` become points (1rem = 16pt). Each type size also maps to the Dynamic Type text style with the nearest default size (ties go to the larger style), so it scales with the user's text size. In Swift, `UIFnTypeSize.font(weight:dynamicTypeSize:)` and the `uifnFont(_:weight:)` view modifier render the theme's points at the default text size and scale them with the text styles: a size equal to a style's default scales exactly like it, and a size between two styles interpolates between them, so the type scale keeps its order at every text size; macOS has no Dynamic Type, so there fonts keep the theme's points.
- `--name` must be a Swift identifier other than `_`, `Type` or `Protocol`. The generated property is backticked, so keywords such as `default` work.
- `--check` exits 1 without writing when the file is out of date. Use it in CI to catch generated files that no longer match their themes.

Inside this repository, `node uifn/swift/scripts/generate-tokens.mjs` regenerates the default theme's committed `UIFnTheme.uifn` file and the consumer test fixture. CI fails if that leaves a diff.
