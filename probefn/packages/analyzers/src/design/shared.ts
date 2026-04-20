export type DesignSeverity = 'low' | 'medium' | 'high';

export type DesignCategory =
  | 'overflow'
  | 'clipping'
  | 'overlap'
  | 'spacing'
  | 'alignment'
  | 'responsive'
  | 'token-drift'
  | 'focus-state'
  | 'touch-target'
  | 'contrast-metadata';

export interface DesignFinding {
  findingId: string;
  severity: DesignSeverity;
  category: DesignCategory;
  summary: string;
  evidenceReferences: string[];
  unstable?: boolean;
}

export interface LayoutElement {
  elementId: string;
  role: string;
  name: string;
  text: string;
  visible: boolean;
  disabled: boolean;
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  selectorHints: {
    id?: string;
    testId?: string;
    role?: string;
    name?: string;
  };
}

export interface StyleElementRecord {
  role: string;
  name: string;
  text: string;
  id?: string;
  testId?: string;
  visible?: boolean;
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  clientWidth: number;
  clientHeight: number;
  scrollWidth: number;
  scrollHeight: number;
  color: string;
  backgroundColor: string;
  outlineStyle: string;
  outlineWidth: string;
  outlineColor: string;
  boxShadow: string;
  borderColor: string;
  borderWidth: string;
  fontSize: string;
  lineHeight: string;
  whiteSpace: string;
  overflowX: string;
  overflowY: string;
  textOverflow: string;
  focusable: boolean;
  focusIndicatorVisible: boolean;
}

export interface DesignTokenRule {
  findingId?: string;
  severity?: DesignSeverity;
  summaryLabel?: string;
  match: {
    id?: string;
    testId?: string;
    role?: string;
    name?: string;
  };
  property: 'backgroundColor' | 'color' | 'borderColor';
  expected: string;
}

export interface DesignTokenMap {
  rules: DesignTokenRule[];
}

export interface DesignAuditBundle {
  sessionId: string;
  checkpointId: string;
  checkpointPath: string;
  layoutPath: string;
  viewport: {
    width: number;
    height: number;
  };
  layout: {
    url?: string;
    document?: {
      scrollWidth?: number;
      scrollHeight?: number;
      clientWidth?: number;
      clientHeight?: number;
    };
    elements: LayoutElement[];
  };
  styles?: {
    root?: Record<string, unknown>;
    body?: Record<string, unknown>;
    elements?: StyleElementRecord[];
  };
  unstable: boolean;
}

export interface AnalyzerResult {
  findings: DesignFinding[];
  warnings: string[];
}

export const DESIGN_SEVERITY_POLICY = [
  {
    category: 'overflow',
    high: 'Any horizontal overflow above 16px or any viewport escape by a primary content container.',
    medium: 'Overflow between 5px and 16px.',
    low: 'Minor overflow up to 4px.',
  },
  {
    category: 'clipping',
    high: 'Critical text or controls clipped so interaction is compromised.',
    medium: 'Readable content clipped but interaction still possible.',
    low: 'Decorative or low-impact clipping.',
  },
  {
    category: 'overlap',
    high: 'Interactive or primary content elements overlap meaningfully.',
    medium: 'Noticeable overlap between visible elements.',
    low: 'Minor decorative overlap.',
  },
  {
    category: 'spacing',
    high: 'Spacing rhythm breaks the layout hierarchy across repeated items.',
    medium: 'Visible spacing inconsistency above 16px.',
    low: 'Minor spacing inconsistency above 8px.',
  },
  {
    category: 'alignment',
    high: 'Primary controls or cards visibly misalign.',
    medium: 'Visible alignment drift above 12px.',
    low: 'Minor alignment drift above 6px.',
  },
  {
    category: 'responsive',
    high: 'Mobile/tablet viewport breakage blocks intended layout use.',
    medium: 'Responsive wrapping causes degraded but usable layout.',
    low: 'Minor responsive roughness.',
  },
  {
    category: 'token-drift',
    high: 'Core brand or system token is badly violated.',
    medium: 'Configured token deviates on an important element.',
    low: 'Small token drift on a low-impact surface.',
  },
  {
    category: 'focus-state',
    high: 'Keyboard focus becomes effectively invisible on a primary control.',
    medium: 'Visible focus is missing on a standard control.',
    low: 'Focus styling is weak but still detectable.',
  },
  {
    category: 'touch-target',
    high: 'Touch target is materially smaller than 44x44.',
    medium: 'Touch target is below 44px in one dimension.',
    low: 'Touch target is borderline for comfortable use.',
  },
  {
    category: 'contrast-metadata',
    high: 'Foreground/background pairing appears effectively unreadable.',
    medium: 'Low contrast metadata suggests readability risk.',
    low: 'Potential contrast softness.',
  },
] as const;

export function createFinding(
  input: Omit<DesignFinding, 'unstable'> & { unstable?: boolean },
): DesignFinding {
  return {
    findingId: input.findingId,
    severity: input.severity,
    category: input.category,
    summary: input.summary,
    evidenceReferences: input.evidenceReferences,
    ...(input.unstable ? { unstable: true } : {}),
  };
}

export function describeElement(element: {
  selectorHints?: { id?: string; testId?: string; name?: string };
  name?: string;
  text?: string;
  role?: string;
  id?: string;
  testId?: string;
}): string {
  return (
    element.selectorHints?.id ||
    element.id ||
    element.selectorHints?.testId ||
    element.testId ||
    element.selectorHints?.name ||
    element.name ||
    element.text ||
    element.role ||
    'element'
  )
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (character) => character.toUpperCase())
    .replace(/\bCta\b/g, 'CTA')
    .replace(/\bHmr\b/g, 'HMR');
}

export function fullyContains(
  left: { bounds: { x: number; y: number; width: number; height: number } },
  right: { bounds: { x: number; y: number; width: number; height: number } },
  tolerance = 1,
): boolean {
  return (
    left.bounds.x <= right.bounds.x + tolerance &&
    left.bounds.y <= right.bounds.y + tolerance &&
    left.bounds.x + left.bounds.width >= right.bounds.x + right.bounds.width - tolerance &&
    left.bounds.y + left.bounds.height >= right.bounds.y + right.bounds.height - tolerance
  );
}

export function parsePixelValue(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function parseRgbChannels(color: string): [number, number, number] | null {
  const match = /rgba?\(([^)]+)\)/i.exec(color);
  const rawChannels = match?.[1];
  if (!rawChannels) {
    return null;
  }

  const channels = rawChannels
    .split(',')
    .slice(0, 3)
    .map((channel) => Number.parseFloat(channel.trim()));
  if (channels.length !== 3 || channels.some((channel) => !Number.isFinite(channel))) {
    return null;
  }

  return [channels[0] ?? 0, channels[1] ?? 0, channels[2] ?? 0];
}

export function approximateContrastRatio(
  foreground: string,
  background: string,
): number | null {
  const foregroundChannels = parseRgbChannels(foreground);
  const backgroundChannels = parseRgbChannels(background);
  if (!foregroundChannels || !backgroundChannels) {
    return null;
  }

  const luminance = ([red, green, blue]: [number, number, number]): number => {
    const linearized = [red, green, blue].map((channel) => {
      const normalized = channel / 255;
      return normalized <= 0.03928
        ? normalized / 12.92
        : ((normalized + 0.055) / 1.055) ** 2.4;
    });

    const [linearRed = 0, linearGreen = 0, linearBlue = 0] = linearized;
    return 0.2126 * linearRed + 0.7152 * linearGreen + 0.0722 * linearBlue;
  };

  const foregroundLuminance = luminance(foregroundChannels);
  const backgroundLuminance = luminance(backgroundChannels);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);

  return (lighter + 0.05) / (darker + 0.05);
}
