import {
  approximateContrastRatio,
  createFinding,
  parseRgbChannels,
  type AnalyzerResult,
  type DesignAuditBundle,
  type DesignFinding,
  type DesignTokenMap,
} from './shared.js';

export function analyzeTokenDrift(
  bundle: DesignAuditBundle,
  tokenMap?: DesignTokenMap,
  options: {
    warnOnMissingTokenMap?: boolean;
  } = {},
): AnalyzerResult {
  const findings: DesignFinding[] = [];
  const warnings: string[] = [];
  const styleElements = bundle.styles?.elements ?? [];

  if (!tokenMap || tokenMap.rules.length === 0) {
    if (options.warnOnMissingTokenMap) {
      warnings.push('Token configuration unavailable; token-drift checks skipped.');
    }
  } else {
    for (const rule of tokenMap.rules) {
      const matchingElement = styleElements.find((element) => matchesTokenRule(element, rule.match));
      if (!matchingElement) {
        continue;
      }

      const actualValue = normalizeColor((matchingElement[rule.property] as string | undefined) ?? '');
      const expectedValue = normalizeColor(rule.expected);
      if (!actualValue || actualValue === expectedValue) {
        continue;
      }

      findings.push(createFinding({
        findingId: rule.findingId ?? 'df_token',
        severity: rule.severity ?? 'medium',
        category: 'token-drift',
        summary: `${rule.summaryLabel ?? 'Configured token'} ${actualValue} deviates from configured token color ${expectedValue}.`,
        evidenceReferences: [bundle.checkpointPath],
        unstable: bundle.unstable,
      }));
    }
  }

  for (const element of styleElements) {
    if (element.visible === false) {
      continue;
    }

    if (isTransparentBackground(element.backgroundColor)) {
      continue;
    }

    const label = element.name || element.text || element.id || element.role;
    if (!label || label.length > 120) {
      continue;
    }

    const contrastRatio = approximateContrastRatio(element.color, element.backgroundColor);
    if (contrastRatio !== null && contrastRatio < 2.8) {
      findings.push(createFinding({
        findingId: 'df_contrast',
        severity: contrastRatio < 1.8 ? 'high' : 'medium',
        category: 'contrast-metadata',
        summary: `${label} has low contrast metadata (${contrastRatio.toFixed(2)}:1).`,
        evidenceReferences: [bundle.checkpointPath],
        unstable: bundle.unstable,
      }));
    }
  }

  return {
    findings,
    warnings,
  };
}

function matchesTokenRule(
  element: NonNullable<NonNullable<DesignAuditBundle['styles']>['elements']>[number],
  match: NonNullable<DesignTokenMap['rules'][number]>['match'],
): boolean {
  return (
    (match.id ? element.id === match.id : true) &&
    (match.testId ? element.testId === match.testId : true) &&
    (match.role ? element.role === match.role : true) &&
    (match.name ? element.name === match.name : true)
  );
}

function normalizeColor(color: string): string {
  const trimmed = color.trim();
  const rgbChannels = parseRgbChannels(trimmed);
  if (rgbChannels) {
    return `#${rgbChannels
      .map((channel) => Math.round(channel).toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase()}`;
  }

  return trimmed.toUpperCase();
}

function isTransparentBackground(color: string): boolean {
  const normalized = color.trim().toLowerCase();
  return normalized === 'transparent' || normalized === 'rgba(0, 0, 0, 0)' || normalized === 'rgba(0,0,0,0)';
}
