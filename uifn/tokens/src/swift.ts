import { createFoundationalTokens } from './foundations';
import { oklchToGamutMappedRgb, type RgbTriple } from './gamut';
import { parseColorToOklch } from './oklch';
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
const SWIFT_RESERVED = new Set([
  'associatedtype', 'class', 'deinit', 'enum', 'extension', 'fileprivate', 'func', 'import', 'init', 'inout',
  'internal', 'let', 'open', 'operator', 'private', 'protocol', 'public', 'rethrows', 'static', 'struct',
  'subscript', 'typealias', 'var', 'break', 'case', 'continue', 'default', 'defer', 'do', 'else', 'fallthrough',
  'for', 'guard', 'if', 'in', 'repeat', 'return', 'switch', 'where', 'while', 'as', 'Any', 'catch', 'false', 'is',
  'nil', 'super', 'self', 'Self', 'throw', 'throws', 'true', 'try', 'Type',
]);

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

function swiftNumber(value: number, path: string): string {
  if (!Number.isFinite(value)) {
    throw unsupported('Swift numeric tokens must be finite.', { path, value: String(value) });
  }
  const rounded = Number(value.toFixed(6));
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

/** Converts a non-negative `px` or `rem` dimension (1rem = 16pt) to points. */
export function dimensionToPoints(value: string | number, path: string): number {
  const match = /^\s*((?:\d+(?:\.\d*)?|\.\d+))(px|rem)\s*$/i.exec(String(value));
  if (!match) {
    throw unsupported('Swift dimensions must be non-negative px or rem values.', { path, value });
  }
  const amount = Number(match[1]);
  return finite(match[2].toLowerCase() === 'rem' ? amount * 16 : amount, path, value);
}

/** Converts an `ms` or `s` duration to seconds. */
export function durationToSeconds(value: string | number, path: string): number {
  const match = /^\s*((?:\d+(?:\.\d*)?|\.\d+))(ms|s)\s*$/i.exec(String(value));
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
  const numbers = points.map((part) => (/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(part) ? Number(part) : Number.NaN));
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

// The tokens Swift emits besides colors. Only these must agree across appearances.
const EMITTED_NON_COLOR_PATHS: readonly string[] = [
  ...PUBLIC_TOKEN_GROUPS.space.value.map((name) => `space.${name}`),
  ...PUBLIC_TOKEN_GROUPS.radius.value.map((name) => `radius.${name}`),
  ...(['size', 'lineHeight', 'weight'] as const).flatMap((group) =>
    PUBLIC_TOKEN_GROUPS.typography[group].map((name) => `typography.${group}.${name}`)
  ),
  ...(['duration', 'easing'] as const).flatMap((group) =>
    PUBLIC_TOKEN_GROUPS.motion[group].map((name) => `motion.${group}.${name}`)
  ),
];

const FOUNDATION_TOKENS = new Map(
  flattenTokens(createFoundationalTokens()).map(({ path, token }) => [path.join('.'), token])
);

// Themes may omit the foundations (spacing, typography and other non-color
// groups), which the web theme provider fills from createFoundationalTokens.
// Each token the theme omits takes its foundation value; supplied tokens win.
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

function outputKey(token: DesignToken): string {
  return JSON.stringify([token.$type, token.$value, token.$extensions?.uifn?.reducedMotionValue ?? null]);
}

function resolveAppearances(themes: SwiftThemeSet): Record<SwiftAppearance, Map<string, DesignToken>> {
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
  const resolved = { light, dark, highContrastLight, highContrastDark };

  // Every variant must define exactly the light theme's colors so none is
  // dropped or guessed. The emitted non-color tokens are appearance-independent
  // in Swift; tokens Swift does not emit (font families, shadows, control,
  // icon, border and density) may differ freely.
  const lightColors = colorPaths(light);
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
    for (const path of EMITTED_NON_COLOR_PATHS) {
      const token = tokens.get(path);
      const base = light.get(path);
      if (token && base && outputKey(token) !== outputKey(base)) {
        throw invalid('Spacing, radius, type scale and motion tokens must match the light theme in every appearance.', {
          appearance,
          path,
        });
      }
    }
  }

  return resolved;
}

function colorPaths(light: Map<string, DesignToken>): string[] {
  const groups: string[] = COLOR_GROUPS.map(([group]) => group);
  if ([...light.keys()].some((path) => path.startsWith('color.custom.'))) groups.push('custom');
  return groups.flatMap((group) =>
    (PUBLIC_TOKEN_GROUPS.color[group as keyof typeof PUBLIC_TOKEN_GROUPS.color] as readonly string[]).map(
      (name) => `color.${group}.${name}`
    )
  );
}

function colorValue(token: DesignToken, path: string): SwiftColorValue {
  try {
    return themeColorToSwiftValue(String(token.$value));
  } catch {
    throw unsupported('Swift colors must be OKLCH or hex values.', { path, value: token.$value });
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
  const hasCustom = paths.some((path) => path.startsWith('color.custom.'));
  const groups: Array<readonly [string, string]> = [...COLOR_GROUPS, ...(hasCustom ? [['custom', 'UIFnToneColors'] as const] : [])];

  writer.open('colors: UIFnColors(');
  groups.forEach(([group, type], groupIndex) => {
    const names = PUBLIC_TOKEN_GROUPS.color[group as keyof typeof PUBLIC_TOKEN_GROUPS.color] as readonly string[];
    writer.open(`${group}: ${type}(`);
    names.forEach((name, index) => {
      writeColor(writer, swiftMember(name), `color.${group}.${name}`, appearances, index === names.length - 1);
    });
    writer.close(`)${groupIndex === groups.length - 1 ? '' : ','}`);
  });
  writer.close('),');
}

function writeDimensions(
  writer: SwiftWriter,
  label: string,
  type: string,
  entries: Array<[string, string]>,
  tokens: Map<string, DesignToken>,
  isLast = false
): void {
  writer.open(`${label}: ${type}(`);
  entries.forEach(([member, path], index) => {
    const comma = index === entries.length - 1 ? '' : ',';
    writer.line(`${member}: ${swiftNumber(dimensionToPoints(requireToken(tokens, path).$value, path), path)}${comma}`);
  });
  writer.close(`)${isLast ? '' : ','}`);
}

function writeTypography(writer: SwiftWriter, tokens: Map<string, DesignToken>): void {
  const { size, lineHeight, weight } = PUBLIC_TOKEN_GROUPS.typography;
  writer.open('typography: UIFnTypography(');
  writer.open('size: UIFnTypeScale(');
  size.forEach((name, index) => {
    const path = `typography.size.${name}`;
    const points = dimensionToPoints(requireToken(tokens, path).$value, path);
    const comma = index === size.length - 1 ? '' : ',';
    writer.line(`${name}: UIFnTypeSize(points: ${swiftNumber(points, path)}, textStyle: .${swiftTextStyleForPoints(points)})${comma}`);
  });
  writer.close('),');
  writer.open('lineHeight: UIFnLineHeights(');
  lineHeight.forEach((name, index) => {
    const path = `typography.lineHeight.${name}`;
    const value = Number(requireToken(tokens, path).$value);
    if (!Number.isFinite(value) || value <= 0) {
      throw unsupported('Swift line heights must be finite positive numbers.', { path, value: String(value) });
    }
    writer.line(`${name}: ${swiftNumber(value, path)}${index === lineHeight.length - 1 ? '' : ','}`);
  });
  writer.close('),');
  writer.open('weight: UIFnFontWeights(');
  weight.forEach((name, index) => {
    const path = `typography.weight.${name}`;
    const value = Number(requireToken(tokens, path).$value);
    if (!Number.isInteger(value) || value < 1 || value > 1000) {
      throw unsupported('Swift font weights must be integers in 1...1000.', { path, value });
    }
    writer.line(`${name}: UIFnFontWeight(${value})${index === weight.length - 1 ? '' : ','}`);
  });
  writer.close(')');
  writer.close('),');
}

function writeMotion(writer: SwiftWriter, tokens: Map<string, DesignToken>): void {
  const { duration, easing } = PUBLIC_TOKEN_GROUPS.motion;
  writer.open('motion: UIFnMotion(');
  writer.open('duration: UIFnMotionDurations(');
  duration.forEach((name, index) => {
    const path = `motion.duration.${name}`;
    const token = requireToken(tokens, path);
    const seconds = durationToSeconds(token.$value, path);
    const reduced = durationToSeconds(token.$extensions!.uifn!.reducedMotionValue!, `${path}.reducedMotionValue`);
    const comma = index === duration.length - 1 ? '' : ',';
    writer.line(`${name}: UIFnDuration(seconds: ${swiftNumber(seconds, path)}, reducedMotionSeconds: ${swiftNumber(reduced, path)})${comma}`);
  });
  writer.close('),');
  writer.open('easing: UIFnMotionEasings(');
  easing.forEach((name, index) => {
    const path = `motion.easing.${name}`;
    const points = parseCubicBezier(requireToken(tokens, path).$value, path)
      .map((value) => swiftNumber(value, path))
      .join(', ');
    writer.line(`${name}: UIFnEasing(${points})${index === easing.length - 1 ? '' : ','}`);
  });
  writer.close(')');
  writer.close(')');
}

/**
 * Generates one Swift source file declaring `UIFnTheme.<name>` from a uifn
 * theme set. Each theme is validated with `validateTokenTheme` and its token
 * references are resolved first.
 */
export function generateSwiftTokens(themes: SwiftThemeSet, options: SwiftTokenOptions): string {
  if (!SWIFT_IDENTIFIER.test(options.name) || SWIFT_RESERVED.has(options.name)) {
    throw invalid('Swift theme name must be a Swift identifier that is not a keyword.', { name: options.name });
  }
  const imports = options.imports ?? [];
  const invalidImport = imports.find((module) => !SWIFT_IDENTIFIER.test(module));
  if (invalidImport !== undefined) {
    throw invalid('Swift imports must be module identifiers.', { module: invalidImport });
  }

  const appearances = resolveAppearances(themes);
  const tokens = appearances.light;
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
    writer.line(`import ${module}`);
  }
  writer.line();
  writer.open(`${access === 'public' ? 'public ' : ''}extension UIFnTheme {`);
  writer.line(`/// The ${options.name} theme.`);
  writer.open(`static let ${options.name} = UIFnTheme(`);
  writer.line(`name: ${swiftString(options.name)},`);
  writeColors(writer, appearances);
  writeDimensions(
    writer,
    'spacing',
    'UIFnSpacing',
    PUBLIC_TOKEN_GROUPS.space.value.map((name) => [`space${name}`, `space.${name}`]),
    tokens
  );
  writeDimensions(
    writer,
    'radius',
    'UIFnRadius',
    PUBLIC_TOKEN_GROUPS.radius.value.map((name) => [name, `radius.${name}`]),
    tokens
  );
  writeTypography(writer, tokens);
  writeMotion(writer, tokens);
  writer.close(')');
  writer.close('}');

  return writer.toString();
}
