import type { OklchColor } from './oklch';

/** Gamma-encoded RGB channels in the 0...1 range. */
export type RgbTriple = [number, number, number];

export type RgbGamut = 'srgb' | 'display-p3';

type Matrix = readonly [
  readonly [number, number, number],
  readonly [number, number, number],
  readonly [number, number, number],
];

// CSS Color 4 conversion matrices (D65 white point).
const OKLAB_TO_LMS: Matrix = [
  [1, 0.3963377773761749, 0.2158037573099136],
  [1, -0.1055613458156586, -0.0638541728258133],
  [1, -0.0894841775298119, -1.2914855480194092],
];
const LMS_TO_XYZ: Matrix = [
  [1.2268798758459243, -0.5578149944602171, 0.2813910456659647],
  [-0.0405757452148008, 1.112286803280317, -0.0717110580655164],
  [-0.0763729366746601, -0.4214933324022432, 1.5869240198367816],
];
const XYZ_TO_LMS: Matrix = [
  [0.819022437996703, 0.3619062600528904, -0.1288737815209879],
  [0.0329836539323885, 0.9292868615863434, 0.0361446663506424],
  [0.0481771893596242, 0.2642395317527308, 0.6335478284694309],
];
const LMS_TO_OKLAB: Matrix = [
  [0.210454268309314, 0.7936177747023054, -0.0040720430116193],
  [1.9779985324311684, -2.42859224204858, 0.450593709617411],
  [0.0259040424655478, 0.7827717124575296, -0.8086757549230774],
];
const XYZ_TO_LINEAR: Record<RgbGamut, Matrix> = {
  srgb: [
    [3.2409699419045226, -1.537383177570094, -0.4986107602930034],
    [-0.9692436362808796, 1.8759675015077202, 0.04155505740717559],
    [0.05563007969699366, -0.20397695888897652, 1.0569715142428786],
  ],
  'display-p3': [
    [2.4934969119414254, -0.9313836179191239, -0.40271078445071684],
    [-0.8294889695615747, 1.7626640603183463, 0.023624685841943577],
    [0.03584583024378447, -0.07617238926804182, 0.9568845240076872],
  ],
};
const LINEAR_TO_XYZ: Record<RgbGamut, Matrix> = {
  srgb: [
    [0.41239079926595934, 0.357584339383878, 0.1804807884018343],
    [0.21263900587151027, 0.715168678767756, 0.07219231536073371],
    [0.01933081871559182, 0.11919477979462598, 0.9505321522496607],
  ],
  'display-p3': [
    [0.4865709486482162, 0.26566769316909306, 0.1982172852343625],
    [0.2289745640697488, 0.6917385218365064, 0.079286914093745],
    [0, 0.04511338185890264, 1.043944368900976],
  ],
};

// CSS Color 4 gamut mapping constants: just-noticeable difference in deltaEOK
// and the chroma search precision. IN_GAMUT_EPSILON tolerates float noise at
// the gamut boundary.
const JND = 0.02;
const CHROMA_EPSILON = 0.0001;
const IN_GAMUT_EPSILON = 0.000075;

function multiply(matrix: Matrix, [x, y, z]: RgbTriple): RgbTriple {
  return [
    matrix[0][0] * x + matrix[0][1] * y + matrix[0][2] * z,
    matrix[1][0] * x + matrix[1][1] * y + matrix[1][2] * z,
    matrix[2][0] * x + matrix[2][1] * y + matrix[2][2] * z,
  ];
}

function oklchToOklab({ l, c, h }: OklchColor): RgbTriple {
  const radians = (h * Math.PI) / 180;
  return [l, c * Math.cos(radians), c * Math.sin(radians)];
}

function oklabToLinear(lab: RgbTriple, gamut: RgbGamut): RgbTriple {
  const lms = multiply(OKLAB_TO_LMS, lab).map((channel) => channel ** 3) as RgbTriple;
  return multiply(XYZ_TO_LINEAR[gamut], multiply(LMS_TO_XYZ, lms));
}

function linearToOklab(linear: RgbTriple, gamut: RgbGamut): RgbTriple {
  const lms = multiply(XYZ_TO_LMS, multiply(LINEAR_TO_XYZ[gamut], linear));
  return multiply(LMS_TO_OKLAB, lms.map(Math.cbrt) as RgbTriple);
}

// sRGB and Display P3 share the sRGB transfer function.
function encode(channel: number): number {
  const magnitude = Math.abs(channel);
  const encoded = magnitude <= 0.0031308 ? magnitude * 12.92 : 1.055 * magnitude ** (1 / 2.4) - 0.055;
  return Math.sign(channel) * encoded;
}

function decode(channel: number): number {
  const magnitude = Math.abs(channel);
  const decoded = magnitude <= 0.04045 ? magnitude / 12.92 : ((magnitude + 0.055) / 1.055) ** 2.4;
  return Math.sign(channel) * decoded;
}

function toEncodedRgb(color: OklchColor, gamut: RgbGamut): RgbTriple {
  return oklabToLinear(oklchToOklab(color), gamut).map(encode) as RgbTriple;
}

function isInGamut(rgb: RgbTriple): boolean {
  return rgb.every((channel) => channel >= -IN_GAMUT_EPSILON && channel <= 1 + IN_GAMUT_EPSILON);
}

function clip(rgb: RgbTriple): RgbTriple {
  return rgb.map((channel) => Math.min(Math.max(channel, 0), 1)) as RgbTriple;
}

function deltaEOK(rgb: RgbTriple, gamut: RgbGamut, reference: OklchColor): number {
  const [l1, a1, b1] = linearToOklab(rgb.map(decode) as RgbTriple, gamut);
  const [l2, a2, b2] = oklchToOklab(reference);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

/** The relative luminance (CIE Y) of gamma-encoded RGB channels in their gamut. */
export function rgbRelativeLuminance(rgb: RgbTriple, gamut: RgbGamut): number {
  return multiply(LINEAR_TO_XYZ[gamut], rgb.map(decode) as RgbTriple)[1];
}

/** Returns true when the OKLCH color is representable in the RGB gamut without clipping. */
export function isOklchInGamut(color: OklchColor, gamut: RgbGamut): boolean {
  return isInGamut(toEncodedRgb(color, gamut));
}

/**
 * Converts an OKLCH color to gamma-encoded RGB in the requested gamut.
 *
 * Out-of-gamut colors are mapped with the CSS Color 4 algorithm: chroma is
 * reduced in OKLCH at constant lightness and hue until the clipped result is
 * within one just-noticeable difference (deltaEOK 0.02) of the reduced color.
 */
export function oklchToGamutMappedRgb(color: OklchColor, gamut: RgbGamut): RgbTriple {
  if (color.l >= 1) return [1, 1, 1];
  if (color.l <= 0) return [0, 0, 0];

  const origin = toEncodedRgb(color, gamut);
  if (isInGamut(origin)) return clip(origin);

  let clipped = clip(origin);
  if (deltaEOK(clipped, gamut, color) < JND) return clipped;

  let min = 0;
  let max = color.c;
  let minInGamut = true;
  while (max - min > CHROMA_EPSILON) {
    const chroma = (min + max) / 2;
    const current = { ...color, c: chroma };
    const rgb = toEncodedRgb(current, gamut);
    if (minInGamut && isInGamut(rgb)) {
      min = chroma;
      continue;
    }

    clipped = clip(rgb);
    const error = deltaEOK(clipped, gamut, current);
    if (error < JND) {
      if (JND - error < CHROMA_EPSILON) return clipped;
      minInGamut = false;
      min = chroma;
    } else {
      max = chroma;
    }
  }

  return clipped;
}
