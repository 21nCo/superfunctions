import {
  createFinding,
  describeElement,
  fullyContains,
  type DesignAuditBundle,
  type DesignFinding,
} from './shared.js';

export function analyzeSpacing(
  bundle: DesignAuditBundle,
): DesignFinding[] {
  const candidates = bundle.layout.elements
    .filter((element, _, elements) =>
      element.visible &&
      !elements.some((other) => other.elementId !== element.elementId && other.visible && fullyContains(element, other)) &&
      ['button', 'textbox', 'combobox', 'link'].includes(element.role),
    );

  const dominantRole = selectDominantRole(candidates);
  const verticalSequence = candidates
    .filter((element) => element.role === dominantRole)
    .sort((left, right) => left.bounds.y - right.bounds.y)
    .slice(0, 8);

  if (verticalSequence.length < 4) {
    return [];
  }

  const gaps: number[] = [];
  for (let index = 1; index < verticalSequence.length; index += 1) {
    const previous = verticalSequence[index - 1];
    const current = verticalSequence[index];
    if (!previous || !current) {
      continue;
    }

    const gap = Math.round(current.bounds.y - (previous.bounds.y + previous.bounds.height));
    if (gap >= 0) {
      gaps.push(gap);
    }
  }

  if (gaps.length < 3) {
    return [];
  }

  const minGap = Math.min(...gaps);
  const maxGap = Math.max(...gaps);
  const drift = maxGap - minGap;
  if (drift <= 8) {
    return [];
  }

  return [
    createFinding({
      findingId: 'df_spacing',
      severity: drift > 16 ? 'medium' : 'low',
      category: 'spacing',
      summary: `Vertical spacing rhythm varies by ${drift}px across repeated blocks near ${describeElement(verticalSequence[1] ?? verticalSequence[0] ?? { role: 'section' })}.`,
      evidenceReferences: [bundle.layoutPath],
      unstable: bundle.unstable,
    }),
  ];
}

function selectDominantRole(
  elements: DesignAuditBundle['layout']['elements'],
): string | null {
  const counts = new Map<string, number>();
  for (const element of elements) {
    counts.set(element.role, (counts.get(element.role) ?? 0) + 1);
  }

  let dominantRole: string | null = null;
  let dominantCount = 0;
  for (const [role, count] of counts) {
    if (count > dominantCount) {
      dominantRole = role;
      dominantCount = count;
    }
  }

  return dominantCount >= 4 ? dominantRole : null;
}
