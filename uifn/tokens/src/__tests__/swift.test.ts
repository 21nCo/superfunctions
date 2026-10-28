import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { oklchToGamutMappedRgb } from '../gamut';
import { parseOklch } from '../oklch';
import { UIFnTokenError, type DesignTokenTheme, type TokenTree } from '../schema';
import { runSwiftTokensCli, type SwiftCliIo } from '../swift-cli';
import { generateSwiftTokens, swiftTextStyleForPoints, themeColorToSwiftValue } from '../swift';

const here = dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(readFileSync(join(here, 'fixtures/swift-color-vectors.json'), 'utf8')) as {
  vectors: Array<{ oklch: string; inSrgb: boolean; inDisplayP3: boolean; srgb: number[]; displayP3: number[] }>;
};
const DEFAULT_THEME_FILES = ['uifn-light', 'uifn-dark', 'uifn-high-contrast-light', 'uifn-high-contrast-dark'].map(
  (name) => join(here, '../../../theme/src/themes', `${name}.json`)
);
const EXTRA_VECTORS = [
  'oklch(0% 0 0)',
  'oklch(100% 0 0)',
  'oklch(64% 0.27 29)',
  'oklch(70% 0.3 145)',
  'oklch(90% 0.4 200)',
];

function colorValues(tree: TokenTree): string[] {
  return Object.values(tree).flatMap((value) =>
    '$type' in value ? [String(value.$value)] : colorValues(value as TokenTree)
  );
}

function to8Bit(channels: number[]): number[] {
  return channels.map((channel) => Math.round(channel * 255));
}

function color(value: string) {
  return { $type: 'color' as const, $value: value };
}

function tone(solid: string, subtle: string, contrast: string) {
  return { solid: color(solid), subtle: color(subtle), contrast: color(contrast) };
}

function foundations(): TokenTree {
  return {
    typography: {
      family: { sans: { $type: 'fontFamily', $value: 'system-ui' }, mono: { $type: 'fontFamily', $value: 'monospace' } },
      size: {
        xs: { $type: 'dimension', $value: '0.75rem' },
        sm: { $type: 'dimension', $value: '0.8125rem' },
        md: { $type: 'dimension', $value: '0.875rem' },
        lg: { $type: 'dimension', $value: '1rem' },
        xl: { $type: 'dimension', $value: '1.125rem' },
      },
      lineHeight: {
        tight: { $type: 'number', $value: 1.2 },
        normal: { $type: 'number', $value: 1.45 },
        relaxed: { $type: 'number', $value: 1.65 },
      },
      weight: {
        regular: { $type: 'number', $value: 400 },
        medium: { $type: 'number', $value: 500 },
        semibold: { $type: 'number', $value: 650 },
        bold: { $type: 'number', $value: 700 },
      },
    },
    space: Object.fromEntries(
      [1, 2, 3, 4, 5, 6, 8, 12].map((step) => [String(step), { $type: 'dimension', $value: `${step * 0.25}rem` }])
    ),
    radius: {
      sm: { $type: 'dimension', $value: '4px' },
      md: { $type: 'dimension', $value: '6px' },
      lg: { $type: 'dimension', $value: '8px' },
      xl: { $type: 'dimension', $value: '12px' },
      full: { $type: 'dimension', $value: '9999px' },
    },
    density: {
      compact: { $type: 'number', $value: 0.875 },
      comfortable: { $type: 'number', $value: 1 },
      spacious: { $type: 'number', $value: 1.125 },
    },
    motion: {
      duration: {
        fast: { $type: 'duration', $value: '120ms', $extensions: { uifn: { reducedMotionValue: '0ms' } } },
        normal: { $type: 'duration', $value: '0.18s', $extensions: { uifn: { reducedMotionValue: '0ms' } } },
        slow: { $type: 'duration', $value: '260ms', $extensions: { uifn: { reducedMotionValue: '40ms' } } },
      },
      easing: {
        standard: { $type: 'cubicBezier', $value: 'cubic-bezier(0.2, 0, 0, 1)' },
        entrance: { $type: 'cubicBezier', $value: 'cubic-bezier(0, 0, 0.2, 1)' },
        exit: { $type: 'cubicBezier', $value: 'cubic-bezier(0.4, 0, 1, 1)' },
      },
    },
  };
}

function theme(mode: 'light' | 'dark', overrides: Record<string, string> = {}): DesignTokenTheme {
  const light = mode === 'light';
  const surface = light ? 'oklch(98% 0.01 250)' : 'oklch(15% 0.015 250)';
  const ink = light ? 'oklch(20% 0.02 250)' : 'oklch(95% 0.01 250)';
  const onSolid = light ? 'oklch(100% 0 0)' : 'oklch(12% 0.01 250)';
  const solidL = light ? '50%' : '72%';
  const tokens = {
    color: {
      surface: Object.fromEntries(
        ['canvas', 'raised', 'sunken', 'overlay', 'depth-0', 'depth-1', 'depth-2', 'depth-3', 'depth-4'].map((name) => [
          name,
          color(surface),
        ])
      ),
      text: { primary: color(ink), secondary: color(ink), muted: color(ink), disabled: color(ink) },
      border: { subtle: color(ink), default: color(ink), strong: color(ink) },
      accent: tone(`oklch(${solidL} 0.18 250)`, surface, onSolid),
      danger: tone(`oklch(${solidL} 0.19 25)`, surface, onSolid),
      warning: tone(light ? 'oklch(64% 0.16 80)' : 'oklch(76% 0.16 80)', surface, 'oklch(18% 0.02 80)'),
      success: tone(`oklch(${solidL} 0.14 145)`, surface, onSolid),
    },
    ...foundations(),
  } as TokenTree;
  for (const [path, value] of Object.entries(overrides)) {
    const segments = path.split('.');
    let node = tokens as Record<string, unknown>;
    segments.slice(0, -1).forEach((segment) => {
      node[segment] ??= {};
      node = node[segment] as Record<string, unknown>;
    });
    node[segments.at(-1)!] = color(value);
  }
  return { name: `fixture-${mode}`, mode, tokens };
}

function errorOf(run: () => unknown): UIFnTokenError {
  try {
    run();
  } catch (error) {
    if (error instanceof UIFnTokenError) return error;
    throw error;
  }
  throw new Error('Expected a UIFnTokenError.');
}

function colorBlock(swift: string, member: string): string {
  const start = swift.indexOf(`${member}: UIFnColorToken(`);
  return swift.slice(start, swift.indexOf('\n            )', start));
}

describe('OKLCH to Display P3 and sRGB', () => {
  it('covers exactly the default theme colors plus black, white and three out-of-gamut values', () => {
    const themeColors = DEFAULT_THEME_FILES.flatMap((file) =>
      colorValues((JSON.parse(readFileSync(file, 'utf8')) as DesignTokenTheme).tokens.color as TokenTree)
    );
    expect(new Set(vectors.vectors.map((vector) => vector.oklch))).toEqual(new Set([...themeColors, ...EXTRA_VECTORS]));
    const outOfGamut = EXTRA_VECTORS.slice(2).map((value) => vectors.vectors.find((vector) => vector.oklch === value)!);
    expect(outOfGamut.every((vector) => !vector.inSrgb)).toBe(true);
    expect(outOfGamut.filter((vector) => !vector.inDisplayP3)).toHaveLength(2);
  });

  it.each(vectors.vectors)('matches the reference for $oklch within 1/255', ({ oklch, srgb, displayP3 }) => {
    const value = themeColorToSwiftValue(oklch);
    to8Bit(value.srgb).forEach((channel, index) => expect(Math.abs(channel - srgb[index])).toBeLessThanOrEqual(1));
    to8Bit(value.displayP3).forEach((channel, index) =>
      expect(Math.abs(channel - displayP3[index])).toBeLessThanOrEqual(1)
    );
  });

  it('reduces chroma for out-of-gamut colors instead of clipping each channel', () => {
    // Clipping channels gives sRGB (149, 0, 0) and Display P3 (0, 255, 255)
    // for these colors; reducing chroma gives the CSS Color 4 results.
    expect(to8Bit(oklchToGamutMappedRgb(parseOklch('oklch(36% 0.24 25)'), 'srgb'))).toEqual([126, 0, 3]);
    expect(to8Bit(oklchToGamutMappedRgb(parseOklch('oklch(90% 0.4 200)'), 'display-p3'))).toEqual([64, 253, 255]);
  });

  it('accepts hex colors as sRGB', () => {
    expect(to8Bit(themeColorToSwiftValue('#336699').srgb)).toEqual([0x33, 0x66, 0x99]);
  });
});

describe('generateSwiftTokens', () => {
  it('writes per-appearance colors, points, Dynamic Type styles and motion for a full theme set', () => {
    const swift = generateSwiftTokens(
      {
        light: theme('light'),
        dark: theme('dark'),
        highContrastLight: { ...theme('light', { 'color.text.primary': 'oklch(0% 0 0)' }), name: 'fixture-hcl', mode: 'high-contrast-light' },
        highContrastDark: { ...theme('dark', { 'color.text.primary': 'oklch(100% 0 0)' }), name: 'fixture-hcd', mode: 'high-contrast-dark' },
      },
      { name: 'fixture', regenerateCommand: 'npm run generate' }
    );

    expect(swift).toContain('// Regenerate with: npm run generate');
    expect(swift).toContain('public extension UIFnTheme {');
    expect(swift).toContain('    static let fixture = UIFnTheme(');
    const primary = colorBlock(swift, 'primary');
    expect(primary).toContain('// light: oklch(20% 0.02 250)');
    expect(primary).toContain('// dark: oklch(95% 0.01 250)');
    expect(primary).toContain('highContrastLight: UIFnColorValue(displayP3: UIFnRGB(0, 0, 0), sRGB: UIFnRGB(0, 0, 0))');
    expect(primary).toContain('highContrastDark: UIFnColorValue(displayP3: UIFnRGB(1, 1, 1), sRGB: UIFnRGB(1, 1, 1))');
    expect(swift).toContain('default: UIFnColorToken(');
    expect(swift).toContain('depth0: UIFnColorToken(');
    expect(swift).not.toContain('custom:');
    expect(swift).toContain('space4: 16,');
    expect(swift).toContain('full: 9999');
    expect(swift).toContain('xs: UIFnTypeSize(points: 12, textStyle: .caption),');
    expect(swift).toContain('md: UIFnTypeSize(points: 14, textStyle: .subheadline),');
    expect(swift).toContain('xl: UIFnTypeSize(points: 18, textStyle: .body)');
    expect(swift).toContain('semibold: UIFnFontWeight(650),');
    expect(swift).toContain('normal: UIFnDuration(seconds: 0.18, reducedMotionSeconds: 0),');
    expect(swift).toContain('slow: UIFnDuration(seconds: 0.26, reducedMotionSeconds: 0.04)');
    expect(swift).toContain('exit: UIFnEasing(0.4, 0, 1, 1)');
    expect(generateSwiftTokens({ light: theme('light'), dark: theme('dark') }, { name: 'fixture' })).toBe(
      generateSwiftTokens({ light: theme('light'), dark: theme('dark') }, { name: 'fixture' })
    );
  });

  it('falls back to light for missing appearances, and high-contrast dark to dark when dark exists', () => {
    const lightOnly = colorBlock(generateSwiftTokens({ light: theme('light') }, { name: 'fixture' }), 'canvas');
    const values = lightOnly.split('\n').filter((line) => line.includes('UIFnColorValue(')).map((line) => line.split(': UIFnColorValue')[1].replace(/,$/, ''));
    expect(new Set(values).size).toBe(1);

    const hcl = { ...theme('light', { 'color.surface.canvas': 'oklch(100% 0 0)' }), name: 'hcl', mode: 'high-contrast-light' as const };
    const withDark = colorBlock(generateSwiftTokens({ light: theme('light'), dark: theme('dark'), highContrastLight: hcl }, { name: 'fixture' }), 'canvas');
    expect(withDark).toMatch(/\/\/ highContrastDark: oklch\(15% 0\.015 250\)/);
    const withoutDark = colorBlock(generateSwiftTokens({ light: theme('light'), highContrastLight: hcl }, { name: 'fixture' }), 'canvas');
    expect(withoutDark).toMatch(/\/\/ highContrastDark: oklch\(100% 0 0\)/);
  });

  it('resolves token references and emits the custom tone when the theme defines it', () => {
    const light = theme('light', {
      'color.custom.solid': 'oklch(45% 0.12 300)',
      'color.custom.subtle': 'oklch(94% 0.03 300)',
      'color.custom.contrast': 'oklch(100% 0 0)',
    });
    (light.tokens.color as TokenTree).accent = {
      ...((light.tokens.color as TokenTree).accent as TokenTree),
      subtle: { $type: 'color', $value: '{color.custom.subtle}', $extensions: { uifn: { fallbackValue: 'oklch(94% 0.03 300)' } } },
    };
    const swift = generateSwiftTokens({ light }, { name: 'fixture', access: 'internal', imports: ['UIFnSwiftUI'] });
    expect(swift).toContain('import SwiftUI\nimport UIFnSwiftUI\n');
    expect(swift).toContain('\nextension UIFnTheme {');
    expect(swift).toContain('custom: UIFnToneColors(');
    const accent = swift.slice(swift.indexOf('accent: UIFnToneColors('));
    expect(colorBlock(accent, 'subtle')).toContain('// light: oklch(94% 0.03 300)');
  });

  it('rejects theme sets the Swift API cannot represent', () => {
    const cases: Array<[string, () => unknown, string]> = [
      ['dark mode in the light slot', () => generateSwiftTokens({ light: theme('dark') }, { name: 'fixture' }), 'UIFN_SWIFT_THEME_INVALID'],
      ['keyword name', () => generateSwiftTokens({ light: theme('light') }, { name: 'default' }), 'UIFN_SWIFT_THEME_INVALID'],
      ['bad import', () => generateSwiftTokens({ light: theme('light') }, { name: 'fixture', imports: ['UIFn SwiftUI'] }), 'UIFN_SWIFT_THEME_INVALID'],
      [
        'dark-only custom tone',
        () => generateSwiftTokens({ light: theme('light'), dark: theme('dark', { 'color.custom.solid': 'oklch(70% 0.12 300)', 'color.custom.subtle': 'oklch(30% 0.03 300)', 'color.custom.contrast': 'oklch(12% 0.01 250)' }) }, { name: 'fixture' }),
        'UIFN_SWIFT_THEME_INVALID',
      ],
      [
        'dark radius differs',
        () => {
          const dark = theme('dark');
          (dark.tokens.radius as TokenTree).md = { $type: 'dimension', $value: '7px' };
          return generateSwiftTokens({ light: theme('light'), dark }, { name: 'fixture' });
        },
        'UIFN_SWIFT_THEME_INVALID',
      ],
    ];
    for (const [label, run, code] of cases) {
      expect(errorOf(run).code, label).toBe(code);
    }

    const darkMissingCustom = errorOf(() =>
      generateSwiftTokens({ light: theme('light', { 'color.custom.solid': 'oklch(45% 0.12 300)', 'color.custom.subtle': 'oklch(94% 0.03 300)', 'color.custom.contrast': 'oklch(100% 0 0)' }), dark: theme('dark') }, { name: 'fixture' })
    );
    expect(darkMissingCustom.details).toMatchObject({ appearance: 'dark', path: 'color.custom.solid' });
  });

  it('names the token when a value or group is missing or unsupported', () => {
    const withoutSpace = theme('light');
    delete withoutSpace.tokens.space;
    expect(errorOf(() => generateSwiftTokens({ light: withoutSpace }, { name: 'fixture' })).details).toEqual({ path: 'space.1' });

    const cases: Array<[string, string, string | number]> = [
      ['radius', 'md', '0.5em'],
      ['radius', 'lg', '-8px'],
      ['motion.easing', 'standard', 'ease-in-out'],
      ['motion.easing', 'exit', 'cubic-bezier(1.4, 0, 1, 1)'],
      ['typography.weight', 'bold', 700.5],
    ];
    for (const [group, name, value] of cases) {
      const invalid = theme('light');
      const parent = group.split('.').reduce((node, key) => node[key] as TokenTree, invalid.tokens);
      parent[name] = { ...(parent[name] as object), $value: value } as TokenTree[string];
      const error = errorOf(() => generateSwiftTokens({ light: invalid }, { name: 'fixture' }));
      expect(error.code).toBe('UIFN_SWIFT_TOKEN_UNSUPPORTED');
      expect(error.details).toMatchObject({ path: `${group}.${name}` });
    }
  });

  it('keeps consumer theme names on comment lines', () => {
    const light = { ...theme('light'), name: 'brand\n}\nlet injected = 1 //\u2028x' };
    const swift = generateSwiftTokens({ light }, { name: 'fixture', regenerateCommand: 'make\rtokens' });
    expect(swift).toContain('// Source themes: light: brand } let injected = 1 // x\n');
    expect(swift).toContain('// Regenerate with: make tokens\n');
    expect(swift.split('\n').filter((line) => line.includes('injected'))).toHaveLength(1);
  });

  it('validates each theme before generating', () => {
    const lowContrast = theme('light', { 'color.text.primary': 'oklch(97% 0.01 250)' });
    expect(errorOf(() => generateSwiftTokens({ light: lowContrast }, { name: 'fixture' })).code).toBe('UIFN_CONTRAST_BUDGET');
  });
});

describe('swiftTextStyleForPoints', () => {
  it('maps to the nearest default Dynamic Type size with ties going larger', () => {
    expect([11, 12, 13, 14, 16, 17, 18, 21, 40].map(swiftTextStyleForPoints)).toEqual([
      'caption2', 'caption', 'footnote', 'subheadline', 'callout', 'body', 'body', 'title2', 'largeTitle',
    ]);
  });
});

describe('uifn-swift-tokens CLI', () => {
  function memoryIo(files: Record<string, string>) {
    const out: string[] = [];
    const err: string[] = [];
    const io: SwiftCliIo = {
      readFile: (path) => {
        if (!(path in files)) throw new Error(`ENOENT: ${path}`);
        return files[path];
      },
      writeFile: (path, contents) => {
        files[path] = contents;
      },
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
    };
    return { io, files, out, err };
  }

  it('writes, then checks, the generated file from theme JSON', () => {
    const memory = memoryIo({ 'light.json': JSON.stringify(theme('light')), 'dark.json': JSON.stringify(theme('dark')) });
    const args = ['--name', 'fixture', '--light', 'light.json', '--dark', 'dark.json', '--out', 'Theme.swift'];
    expect(runSwiftTokensCli(args, memory.io)).toBe(0);
    expect(memory.files['Theme.swift']).toBe(generateSwiftTokens({ light: theme('light'), dark: theme('dark') }, { name: 'fixture' }));
    expect(runSwiftTokensCli([...args, '--check'], memory.io)).toBe(0);

    memory.files['Theme.swift'] += '// edited\n';
    expect(runSwiftTokensCli([...args, '--check'], memory.io)).toBe(1);
    expect(memory.err.at(-1)).toContain('Theme.swift is out of date');
    expect(memory.files['Theme.swift']).toContain('// edited');
  });

  it('reports usage and generator errors with distinct exit codes', () => {
    const memory = memoryIo({ 'light.json': JSON.stringify(theme('dark')) });
    expect(runSwiftTokensCli(['--light', 'light.json', '--out', 'Theme.swift'], memory.io)).toBe(2);
    expect(runSwiftTokensCli(['--name', 'x', '--light', 'light.json', '--out', 'T.swift', '--access', 'private'], memory.io)).toBe(2);
    expect(runSwiftTokensCli(['--name', 'x', '--light', 'light.json', '--out', 'T.swift', '--bogus'], memory.io)).toBe(2);
    expect(runSwiftTokensCli(['--name', 'x', '--light', 'light.json', '--out', 'T.swift'], memory.io)).toBe(1);
    expect(memory.err.at(-1)).toContain('"expected":"light"');
    expect(memory.files['T.swift']).toBeUndefined();
  });
});
