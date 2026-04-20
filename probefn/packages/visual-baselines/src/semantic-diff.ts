export type RegressionSeverity = 'low' | 'medium' | 'high' | 'critical';
export type RegressionCategory =
  | 'missing-element'
  | 'moved-element'
  | 'layout-change'
  | 'pixel-drift';

export interface RegressionFinding {
  findingId: string;
  severity: RegressionSeverity;
  category: RegressionCategory;
  summary: string;
  evidenceReferences: string[];
  baselineKey: string;
}

export interface SemanticDiffInput {
  baselineKey: string;
  baselineLayout: {
    elements: LayoutElement[];
  };
  currentLayout: {
    elements: LayoutElement[];
  };
  baselineLayoutPath: string;
  currentLayoutPath: string;
  diffPath: string;
}

interface LayoutElement {
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

export function diffSemanticLayouts(input: SemanticDiffInput): RegressionFinding[] {
  const baselineElements = filterSemanticCandidates(input.baselineLayout.elements);
  const currentElements = filterSemanticCandidates(input.currentLayout.elements);
  const currentByIdentity = new Map(
    currentElements.map((element) => [semanticIdentity(element), element]),
  );

  const findings: RegressionFinding[] = [];

  for (const baselineElement of baselineElements) {
    const identity = semanticIdentity(baselineElement);
    const currentElement = currentByIdentity.get(identity);
    if (!currentElement) {
      findings.push(createMissingFinding(input, baselineElement));
      continue;
    }

    const positionShift = Math.max(
      Math.abs(baselineElement.bounds.x - currentElement.bounds.x),
      Math.abs(baselineElement.bounds.y - currentElement.bounds.y),
    );
    if (positionShift > 24) {
      findings.push({
        findingId: `rf_moved_${normalizeFindingSegment(identity)}`,
        severity: positionShift > 48 ? 'high' : 'medium',
        category: 'moved-element',
        summary: `${describeRegressionElement(baselineElement)} moved by ${positionShift}px relative to the baseline.`,
        evidenceReferences: [input.diffPath, `${input.currentLayoutPath}:${currentElement.elementId}`],
        baselineKey: input.baselineKey,
      });
    }

    const sizeDelta = Math.max(
      Math.abs(baselineElement.bounds.width - currentElement.bounds.width),
      Math.abs(baselineElement.bounds.height - currentElement.bounds.height),
    );
    if (sizeDelta > 24) {
      findings.push({
        findingId: `rf_layout_${normalizeFindingSegment(identity)}`,
        severity: sizeDelta > 48 ? 'high' : 'medium',
        category: 'layout-change',
        summary: `${describeRegressionElement(baselineElement)} changed size by ${sizeDelta}px relative to the baseline.`,
        evidenceReferences: [input.diffPath, `${input.currentLayoutPath}:${currentElement.elementId}`],
        baselineKey: input.baselineKey,
      });
    }
  }

  return dedupeFindings(findings);
}

function filterSemanticCandidates(elements: LayoutElement[]): LayoutElement[] {
  return elements.filter((element) => {
    if (!element.visible || element.disabled) {
      return false;
    }

    if (element.selectorHints.id || element.selectorHints.testId) {
      return true;
    }

    if (['button', 'link', 'textbox', 'combobox'].includes(element.role)) {
      return true;
    }

    const label = `${element.name} ${element.text}`.trim();
    return label.length > 0 && label.length <= 80;
  });
}

function semanticIdentity(element: LayoutElement): string {
  return (
    element.selectorHints.id ||
    element.selectorHints.testId ||
    `${element.role}:${(element.name || element.text).trim().toLowerCase()}`
  );
}

function createMissingFinding(
  input: SemanticDiffInput,
  element: LayoutElement,
): RegressionFinding {
  const identity = semanticIdentity(element);
  const label = describeRegressionElement(element);
  const isPrimaryCta =
    identity.includes('primary-cta') ||
    label.toLowerCase() === 'primary cta';

  return {
    findingId: isPrimaryCta ? 'rf_missing_cta' : `rf_missing_${normalizeFindingSegment(identity)}`,
    severity: isPrimaryCta ? 'critical' : 'high',
    category: 'missing-element',
    summary: isPrimaryCta
      ? 'Primary CTA is absent in the current checkpoint but present in the baseline.'
      : `${label} is absent in the current checkpoint but present in the baseline.`,
    evidenceReferences: [input.diffPath, `${input.baselineLayoutPath}:${element.elementId}`],
    baselineKey: input.baselineKey,
  };
}

function describeRegressionElement(element: LayoutElement): string {
  return (
    element.selectorHints.id ||
    element.selectorHints.testId ||
    element.name ||
    element.text ||
    element.role
  )
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (character: string) => character.toUpperCase())
    .replace(/\bCta\b/g, 'CTA');
}

function normalizeFindingSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase();
}

function dedupeFindings(findings: RegressionFinding[]): RegressionFinding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const signature = `${finding.category}:${finding.summary}`;
    if (seen.has(signature)) {
      return false;
    }

    seen.add(signature);
    return true;
  });
}
