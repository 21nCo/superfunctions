import { createFoundationalTokens } from './foundations';
import { oklchToGamutMappedRgb, rgbRelativeLuminance, type RgbGamut, type RgbTriple } from './gamut';
import { CONTRAST_MINIMUM, luminanceContrastRatio, parseColorToOklch, themeContrastPairs } from './oklch';
import {
  PUBLIC_TOKEN_GROUPS,
  UIFnTokenError,
  flattenTokens,
  type DesignToken,
  type DesignTokenTheme,
} from './schema';
import { resolveTokenReferences, validateTokenTheme } from './validate';

export type SwiftAppearance = 'light' | 'dark' | 'highContrastLight' | 'highContrastDark';

/**
 * The themes behind one Swift theme. Only `light` is required; missing
 * appearances fall back: `dark` and `highContrastLight` to `light`, and
 * `highContrastDark` to `dark` when it is defined, otherwise to
 * `highContrastLight`.
 */
export interface SwiftThemeSet {
  light: DesignTokenTheme;
  dark?: DesignTokenTheme;
  highContrastLight?: DesignTokenTheme;
  highContrastDark?: DesignTokenTheme;
}

export interface SwiftTokenOptions {
  /** Swift identifier of the generated `UIFnTheme` static property, for example `uifn`. */
  name: string;
  /** Access level of the generated property. Defaults to `public`. */
  access?: 'public' | 'internal';
  /** Modules imported in addition to SwiftUI, such as `UIFnSwiftUI` outside the package. */
  imports?: string[];
  /** Command recorded in the file header for regenerating it. */
  regenerateCommand?: string;
}

/** Dynamic Type text styles a type size can map to, with their default (Large) point sizes. */
export type SwiftTextStyle =
  | 'caption2'
  | 'caption'
  | 'footnote'
  | 'subheadline'
  | 'callout'
  | 'body'
  | 'title3'
  | 'title2'
  | 'title'
  | 'largeTitle';

const TEXT_STYLE_POINTS: ReadonlyArray<[SwiftTextStyle, number]> = [
  ['caption2', 11],
  ['caption', 12],
  ['footnote', 13],
  ['subheadline', 15],
  ['callout', 16],
  ['body', 17],
  ['title3', 20],
  ['title2', 22],
  ['title', 28],
  ['largeTitle', 34],
];

export interface SwiftColorValue {
  displayP3: RgbTriple;
  srgb: RgbTriple;
}

const APPEARANCE_MODES: Record<SwiftAppearance, NonNullable<DesignTokenTheme['mode']>> = {
  light: 'light',
  dark: 'dark',
  highContrastLight: 'high-contrast-light',
  highContrastDark: 'high-contrast-dark',
};

const APPEARANCES = Object.keys(APPEARANCE_MODES) as SwiftAppearance[];

// Swift struct layout of UIFnColors in UIFnSwiftUI, in initializer order.
const COLOR_GROUPS = [
  ['surface', 'UIFnSurfaceColors'],
  ['text', 'UIFnTextColors'],
  ['border', 'UIFnBorderColors'],
  ['accent', 'UIFnToneColors'],
  ['danger', 'UIFnToneColors'],
  ['warning', 'UIFnToneColors'],
  ['success', 'UIFnToneColors'],
] as const;

// A lone `_` is the wildcard pattern, not an identifier.
const SWIFT_IDENTIFIER = /^(?:[A-Za-z]\w*|_\w+)$/;
// Even backticked, `UIFnTheme.Type` and `UIFnTheme.Protocol` name metatypes.
const UNREFERENCEABLE_MEMBERS = new Set(['Type', 'Protocol']);

function invalid(message: string, details: Record<string, unknown>): UIFnTokenError {
  return new UIFnTokenError('UIFN_SWIFT_THEME_INVALID', message, details);
}

function unsupported(message: string, details: Record<string, unknown>): UIFnTokenError {
  return new UIFnTokenError('UIFN_SWIFT_TOKEN_UNSUPPORTED', message, details);
}

function swiftMember(name: string): string {
  return name.replaceAll(/-(\w)/g, (_, char: string) => char.toUpperCase());
}

// Theme names and values are consumer input; keep each comment on one line.
function commentText(value: unknown): string {
  return String(value).replaceAll(/[\s\p{Cc}\u2028\u2029]+/gu, ' ').trim();
}

function swiftString(value: string): string {
  return JSON.stringify(value);
}

// Swift source carries six decimals; contrast is measured on the same values.
function serializedNumber(value: number): number {
  return Number(value.toFixed(6));
}

function swiftNumber(value: number, path: string): string {
  if (!Number.isFinite(value)) {
    throw unsupported('Swift numeric tokens must be finite.', { path, value: String(value) });
  }
  const rounded = serializedNumber(value);
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

/** Converts one theme color to Display P3 and sRGB, each gamut-mapped into its own gamut. */
export function themeColorToSwiftValue(input: string): SwiftColorValue {
  const color = parseColorToOklch(input);
  return {
    displayP3: oklchToGamutMappedRgb(color, 'display-p3'),
    srgb: oklchToGamutMappedRgb(color, 'srgb'),
  };
}

/** Maps a point size to the Dynamic Type text style with the nearest default size; ties go to the larger style. */
export function swiftTextStyleForPoints(points: number): SwiftTextStyle {
  let best = TEXT_STYLE_POINTS[0];
  for (const candidate of TEXT_STYLE_POINTS) {
    if (Math.abs(candidate[1] - points) <= Math.abs(best[1] - points)) best = candidate;
  }
  return best[0];
}

function finite(amount: number, path: string, value: unknown): number {
  if (!Number.isFinite(amount)) {
    throw unsupported('Swift numeric tokens must be finite.', { path, value });
  }
  return amount;
}

// A CSS <number> amount: optional sign, digits with an optional fraction, and an
// optional exponent, so `+4px`, `4e0px` and `1.2e2ms` parse like `4px` and `120ms`.
const CSS_NUMBER = String.raw`(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?`;
// Dimensions and durations allow only `+`, so negative amounts stay unsupported.
const DIMENSION_PATTERN = new RegExp(String.raw`^\s*(\+?${CSS_NUMBER})(px|rem)\s*$`, 'i');
const DURATION_PATTERN = new RegExp(String.raw`^\s*(\+?${CSS_NUMBER})(ms|s)\s*$`, 'i');
const BEZIER_NUMBER_PATTERN = new RegExp(String.raw`^[+-]?${CSS_NUMBER}$`);

/** Converts a non-negative `px` or `rem` dimension (1rem = 16pt) to points. */
export function dimensionToPoints(value: string | number, path: string): number {
  const match = DIMENSION_PATTERN.exec(String(value));
  if (!match) {
    throw unsupported('Swift dimensions must be non-negative px or rem values.', { path, value });
  }
  const amount = Number(match[1]);
  return finite(match[2].toLowerCase() === 'rem' ? amount * 16 : amount, path, value);
}

/** Converts an `ms` or `s` duration to seconds. */
export function durationToSeconds(value: string | number, path: string): number {
  const match = DURATION_PATTERN.exec(String(value));
  if (!match) {
    throw unsupported('Swift durations must use ms or s units.', { path, value });
  }
  const amount = Number(match[1]);
  return finite(match[2].toLowerCase() === 'ms' ? amount / 1000 : amount, path, value);
}

/** Parses `cubic-bezier(x1, y1, x2, y2)` with control point x values in 0...1. */
export function parseCubicBezier(value: string | number, path: string): [number, number, number, number] {
  const match = /^\s*cubic-bezier\(([^)]*)\)\s*$/i.exec(String(value));
  const points = match?.[1].split(',').map((part) => part.trim()) ?? [];
  const numbers = points.map((part) => (BEZIER_NUMBER_PATTERN.test(part) ? Number(part) : Number.NaN));
  if (
    numbers.length !== 4 ||
    !numbers.every(Number.isFinite) ||
    numbers[0] < 0 ||
    numbers[0] > 1 ||
    numbers[2] < 0 ||
    numbers[2] > 1
  ) {
    throw unsupported('Swift easing tokens must be cubic-bezier() with x values in 0...1.', { path, value });
  }
  return numbers as [number, number, number, number];
}

const FOUNDATION_TOKENS = new Map(
  flattenTokens(createFoundationalTokens()).map(({ path, token }) => [path.join('.'), token])
);

// Themes may omit the foundations (spacing, typography and other non-color
// groups). Swift fills each omitted token individually from
// createFoundationalTokens, so a partial typography group keeps its supplied
// tokens and takes the rest from the foundations. The web theme provider
// instead spreads the foundations under the theme's top-level groups, so a
// group the theme supplies replaces the whole foundation group there.
function resolvedTokens(theme: DesignTokenTheme): Map<string, DesignToken> {
  validateTokenTheme(theme);
  const { theme: resolved } = resolveTokenReferences(theme);
  const tokens = new Map(flattenTokens(resolved.tokens).map(({ path, token }) => [path.join('.'), token]));
  for (const [path, token] of FOUNDATION_TOKENS) {
    if (!tokens.has(path)) tokens.set(path, token);
  }
  return tokens;
}

function requireToken(tokens: Map<string, DesignToken>, path: string): DesignToken {
  const token = tokens.get(path);
  if (!token) {
    throw unsupported('Swift tokens require this token in the theme.', { path });
  }
  return token;
}

function points(token: DesignToken, path: string): string {
  return swiftNumber(dimensionToPoints(token.$value, path), path);
}

function typeSize(token: DesignToken, path: string): string {
  const points = dimensionToPoints(token.$value, path);
  return `UIFnTypeSize(points: ${swiftNumber(points, path)}, textStyle: .${swiftTextStyleForPoints(points)})`;
}

function lineHeight(token: DesignToken, path: string): string {
  const value = Number(token.$value);
  if (!Number.isFinite(value) || value < 0) {
    throw unsupported('Swift line heights must be finite non-negative numbers.', { path, value: String(value) });
  }
  return swiftNumber(value, path);
}

function fontWeight(token: DesignToken, path: string): string {
  const value = Number(token.$value);
  if (!(value >= 1 && value <= 1000)) {
    throw unsupported('Swift font weights must be numbers in 1...1000.', { path, value: String(value) });
  }
  return `UIFnFontWeight(${swiftNumber(value, path)})`;
}

function duration(token: DesignToken, path: string): string {
  const seconds = durationToSeconds(token.$value, path);
  const reducedPath = `${path}.reducedMotionValue`;
  const reduced = durationToSeconds(token.$extensions!.uifn!.reducedMotionValue!, reducedPath);
  return `UIFnDuration(seconds: ${swiftNumber(seconds, path)}, reducedMotionSeconds: ${swiftNumber(reduced, reducedPath)})`;
}

function easing(token: DesignToken, path: string): string {
  const points = parseCubicBezier(token.$value, path).map((value) => swiftNumber(value, path));
  return `UIFnEasing(${points.join(', ')})`;
}

// Every token Swift emits besides colors, with the Swift expression it
// becomes. These expressions are the normalized values, so `6px` and
// `0.375rem` or `120ms` and `0.12s` are the same token in Swift.
const EMITTED_NON_COLOR_TOKENS: ReadonlyArray<readonly [string, (token: DesignToken, path: string) => string]> = [
  ...PUBLIC_TOKEN_GROUPS.space.value.map((name) => [`space.${name}`, points] as const),
  ...PUBLIC_TOKEN_GROUPS.radius.value.map((name) => [`radius.${name}`, points] as const),
  ...PUBLIC_TOKEN_GROUPS.typography.size.map((name) => [`typography.size.${name}`, typeSize] as const),
  ...PUBLIC_TOKEN_GROUPS.typography.lineHeight.map((name) => [`typography.lineHeight.${name}`, lineHeight] as const),
  ...PUBLIC_TOKEN_GROUPS.typography.weight.map((name) => [`typography.weight.${name}`, fontWeight] as const),
  ...PUBLIC_TOKEN_GROUPS.motion.duration.map((name) => [`motion.duration.${name}`, duration] as const),
  ...PUBLIC_TOKEN_GROUPS.motion.easing.map((name) => [`motion.easing.${name}`, easing] as const),
];

function emittedValues(tokens: Map<string, DesignToken>, appearance: SwiftAppearance): Map<string, string> {
  return new Map(
    EMITTED_NON_COLOR_TOKENS.map(([path, emit]) => {
      try {
        return [path, emit(requireToken(tokens, path), path)];
      } catch (error) {
        if (error instanceof UIFnTokenError) {
          throw new UIFnTokenError(error.code, error.message, { ...error.details, appearance });
        }
        throw error;
      }
    })
  );
}

interface ResolvedAppearances {
  colors: Record<SwiftAppearance, Map<string, DesignToken>>;
  values: Map<string, string>;
}

function resolveAppearances(themes: SwiftThemeSet): ResolvedAppearances {
  const provided = new Map<SwiftAppearance, Map<string, DesignToken>>();
  for (const appearance of APPEARANCES) {
    const theme = themes[appearance];
    if (!theme) continue;
    if (theme.mode !== undefined && theme.mode !== APPEARANCE_MODES[appearance]) {
      throw invalid('Theme mode does not match the appearance it is generated for.', {
        appearance,
        theme: theme.name,
        mode: theme.mode,
        expected: APPEARANCE_MODES[appearance],
      });
    }
    provided.set(appearance, resolvedTokens(theme));
  }

  const light = provided.get('light');
  if (!light) throw invalid('Swift tokens require a light theme.', {});
  const dark = provided.get('dark') ?? light;
  const highContrastLight = provided.get('highContrastLight') ?? light;
  const highContrastDark = provided.get('highContrastDark') ?? (provided.has('dark') ? dark : highContrastLight);
  const colors = { light, dark, highContrastLight, highContrastDark };

  // Every variant must define exactly the light theme's colors so none is
  // dropped or guessed. The emitted non-color tokens are appearance-independent
  // in Swift, so their normalized values must match; tokens Swift does not
  // emit (font families, shadows, control, icon, border and density) may differ.
  const lightColors = colorPaths(light);
  const values = emittedValues(light, 'light');
  for (const [appearance, tokens] of provided) {
    if (appearance === 'light') continue;
    for (const path of lightColors) {
      if (!tokens.has(path)) {
        throw invalid('Variant theme is missing a color the light theme defines.', { appearance, path });
      }
    }
    for (const path of tokens.keys()) {
      if (path.startsWith('color.') && !lightColors.includes(path)) {
        throw invalid('Variant theme defines a color the light theme does not.', { appearance, path });
      }
    }
    for (const [path, value] of emittedValues(tokens, appearance)) {
      if (value !== values.get(path)) {
        throw invalid('Spacing, radius, type scale and motion tokens must match the light theme in every appearance.', {
          appearance,
          path,
        });
      }
    }
  }

  return { colors, values };
}

// The color paths Swift emits: every required color, and the custom tone
// members the light theme defines.
function colorPaths(light: Map<string, DesignToken>): string[] {
  return [...COLOR_GROUPS.map(([group]) => group), 'custom'].flatMap((group) =>
    (PUBLIC_TOKEN_GROUPS.color[group as keyof typeof PUBLIC_TOKEN_GROUPS.color] as readonly string[])
      .map((name) => `color.${group}.${name}`)
      .filter((path) => group !== 'custom' || light.has(path))
  );
}

function colorValue(token: DesignToken, path: string): SwiftColorValue {
  try {
    return themeColorToSwiftValue(String(token.$value));
  } catch {
    throw unsupported('Swift colors must be OKLCH or hex values.', { path, value: token.$value });
  }
}

const EMITTED_GAMUTS: ReadonlyArray<[keyof SwiftColorValue, RgbGamut]> = [
  ['srgb', 'srgb'],
  ['displayP3', 'display-p3'],
];

function serializedLuminance(rgb: RgbTriple, gamut: RgbGamut): number {
  return rgbRelativeLuminance(rgb.map(serializedNumber) as RgbTriple, gamut);
}

// validateTokenTheme measures contrast on channel-clipped sRGB, while Swift
// emits chroma-reduced colors, so an out-of-gamut color can pass there yet be
// unreadable as emitted. Check each contrast pair again on the serialized
// values, comparing the unrounded ratio; the reported ratio is floored so a
// failing pair never reads as the minimum.
function validateEmittedContrast(appearances: Record<SwiftAppearance, Map<string, DesignToken>>): void {
  const checked = new Set<Map<string, DesignToken>>();
  for (const appearance of APPEARANCES) {
    const tokens = appearances[appearance];
    if (checked.has(tokens)) continue;
    checked.add(tokens);
    for (const [foreground, background] of themeContrastPairs(tokens)) {
      const foregroundValue = colorValue(tokens.get(foreground)!, foreground);
      const backgroundValue = colorValue(tokens.get(background)!, background);
      for (const [key, gamut] of EMITTED_GAMUTS) {
        const ratio = luminanceContrastRatio(
          serializedLuminance(foregroundValue[key], gamut),
          serializedLuminance(backgroundValue[key], gamut)
        );
        if (ratio < CONTRAST_MINIMUM) {
          throw new UIFnTokenError('UIFN_CONTRAST_BUDGET', 'Generated Swift color contrast is below the required minimum.', {
            appearance,
            foreground,
            background,
            gamut,
            contrastRatio: Math.floor(ratio * 100) / 100,
            minimum: CONTRAST_MINIMUM,
          });
        }
      }
    }
  }
}

class SwiftWriter {
  private readonly lines: string[] = [];
  private depth = 0;

  line(text = ''): void {
    this.lines.push(text ? `${'    '.repeat(this.depth)}${text}` : '');
  }

  open(text: string): void {
    this.line(text);
    this.depth += 1;
  }

  close(text: string): void {
    this.depth -= 1;
    this.line(text);
  }

  toString(): string {
    return `${this.lines.join('\n')}\n`;
  }
}

function rgb([red, green, blue]: RgbTriple, path: string): string {
  return `UIFnRGB(${swiftNumber(red, path)}, ${swiftNumber(green, path)}, ${swiftNumber(blue, path)})`;
}

function writeColor(
  writer: SwiftWriter,
  label: string,
  path: string,
  appearances: Record<SwiftAppearance, Map<string, DesignToken>>,
  isLast: boolean
): void {
  writer.open(`${label}: UIFnColorToken(`);
  APPEARANCES.forEach((appearance, index) => {
    const token = requireToken(appearances[appearance], path);
    const value = colorValue(token, path);
    writer.line(`// ${appearance}: ${commentText(token.$value)}`);
    const comma = index === APPEARANCES.length - 1 ? '' : ',';
    writer.line(`${appearance}: UIFnColorValue(displayP3: ${rgb(value.displayP3, path)}, sRGB: ${rgb(value.srgb, path)})${comma}`);
  });
  writer.close(`)${isLast ? '' : ','}`);
}

function writeColors(writer: SwiftWriter, appearances: Record<SwiftAppearance, Map<string, DesignToken>>): void {
  const paths = colorPaths(appearances.light);
  // The custom tone is optional and so is each of its members.
  const customNames = PUBLIC_TOKEN_GROUPS.color.custom.filter((name) => paths.includes(`color.custom.${name}`));
  const groups: Array<readonly [string, string, readonly string[]]> = [
    ...COLOR_GROUPS.map(([group, type]) => [group, type, PUBLIC_TOKEN_GROUPS.color[group]] as const),
    ...(customNames.length > 0 ? [['custom', 'UIFnCustomColors', customNames] as const] : []),
  ];

  writer.open('colors: UIFnColors(');
  groups.forEach(([group, type, names], groupIndex) => {
    writer.open(`${group}: ${type}(`);
    names.forEach((name, index) => {
      writeColor(writer, swiftMember(name), `color.${group}.${name}`, appearances, index === names.length - 1);
    });
    writer.close(`)${groupIndex === groups.length - 1 ? '' : ','}`);
  });
  writer.close('),');
}

function writeGroup(
  writer: SwiftWriter,
  label: string,
  type: string,
  entries: ReadonlyArray<readonly [string, string]>,
  values: Map<string, string>,
  isLast = false
): void {
  writer.open(`${label}: ${type}(`);
  entries.forEach(([member, path], index) => {
    writer.line(`${member}: ${values.get(path)!}${index === entries.length - 1 ? '' : ','}`);
  });
  writer.close(`)${isLast ? '' : ','}`);
}

function members(group: readonly string[], prefix: string): Array<[string, string]> {
  return group.map((name) => [name, `${prefix}.${name}`]);
}

function writeTypography(writer: SwiftWriter, values: Map<string, string>): void {
  const { size, lineHeight, weight } = PUBLIC_TOKEN_GROUPS.typography;
  writer.open('typography: UIFnTypography(');
  writeGroup(writer, 'size', 'UIFnTypeScale', members(size, 'typography.size'), values);
  writeGroup(writer, 'lineHeight', 'UIFnLineHeights', members(lineHeight, 'typography.lineHeight'), values);
  writeGroup(writer, 'weight', 'UIFnFontWeights', members(weight, 'typography.weight'), values, true);
  writer.close('),');
}

function writeMotion(writer: SwiftWriter, values: Map<string, string>): void {
  const { duration, easing } = PUBLIC_TOKEN_GROUPS.motion;
  writer.open('motion: UIFnMotion(');
  writeGroup(writer, 'duration', 'UIFnMotionDurations', members(duration, 'motion.duration'), values);
  writeGroup(writer, 'easing', 'UIFnMotionEasings', members(easing, 'motion.easing'), values, true);
  writer.close(')');
}

// Keywords are lowercase words or underscores, plus these capitalized ones;
// backticks make any of them a valid module name.
const CAPITALIZED_KEYWORDS = new Set(['Any', 'Protocol', 'Self', 'Type']);

function swiftModule(name: string): string {
  return /^[a-z_]+$/.test(name) || CAPITALIZED_KEYWORDS.has(name) ? `\`${name}\`` : name;
}

/**
 * Generates one Swift source file declaring `UIFnTheme.<name>` from a uifn
 * theme set. Each theme is validated with `validateTokenTheme` and its token
 * references are resolved first; its contrast pairs must also meet the budget
 * on the emitted sRGB and Display P3 values.
 */
export function generateSwiftTokens(themes: SwiftThemeSet, options: SwiftTokenOptions): string {
  if (!SWIFT_IDENTIFIER.test(options.name) || UNREFERENCEABLE_MEMBERS.has(options.name)) {
    throw invalid('Swift theme name must be a Swift identifier other than Type or Protocol.', { name: options.name });
  }
  const imports = options.imports ?? [];
  const invalidImport = imports.find((module) => !SWIFT_IDENTIFIER.test(module));
  if (invalidImport !== undefined) {
    throw invalid('Swift imports must be module identifiers.', { module: invalidImport });
  }

  const { colors, values } = resolveAppearances(themes);
  validateEmittedContrast(colors);
  const sources = APPEARANCES.filter((appearance) => themes[appearance]).map(
    (appearance) => `${appearance}: ${commentText(themes[appearance]!.name)}`
  );
  const access = options.access ?? 'public';
  const writer = new SwiftWriter();

  writer.line('// Generated by @uifn/tokens generateSwiftTokens. Do not edit.');
  if (options.regenerateCommand) writer.line(`// Regenerate with: ${commentText(options.regenerateCommand)}`);
  writer.line(`// Source themes: ${sources.join(', ')}`);
  writer.line('// Colors are Display P3 and sRGB, each gamut-mapped from OKLCH (CSS Color 4).');
  writer.line();
  for (const module of ['SwiftUI', ...imports.filter((module) => module !== 'SwiftUI')].sort((a, b) => (a < b ? -1 : Number(a > b)))) {
    writer.line(`import ${swiftModule(module)}`);
  }
  writer.line();
  writer.open(`${access === 'public' ? 'public ' : ''}extension UIFnTheme {`);
  writer.line(`/// The ${options.name} theme.`);
  // Backticks keep keyword names, such as `default`, valid declarations.
  writer.open(`static let \`${options.name}\` = UIFnTheme(`);
  writer.line(`name: ${swiftString(options.name)},`);
  writeColors(writer, colors);
  writeGroup(
    writer,
    'spacing',
    'UIFnSpacing',
    PUBLIC_TOKEN_GROUPS.space.value.map((name) => [`space${name}`, `space.${name}`]),
    values
  );
  writeGroup(writer, 'radius', 'UIFnRadius', members(PUBLIC_TOKEN_GROUPS.radius.value, 'radius'), values);
  writeTypography(writer, values);
  writeMotion(writer, values);
  writer.close(')');
  writer.close('}');

  return writer.toString();
}
