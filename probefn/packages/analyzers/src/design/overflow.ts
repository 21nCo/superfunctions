import {
  createFinding,
  describeElement,
  fullyContains,
  type DesignAuditBundle,
  type DesignFinding,
} from './shared.js';

export function analyzeOverflowAndClipping(
  bundle: DesignAuditBundle,
): DesignFinding[] {
  const findings: DesignFinding[] = [];
  const viewportWidth = bundle.viewport.width;
  const stylesByIdentity = new Map(
    (bundle.styles?.elements ?? []).map((element) => [styleIdentity(element), element]),
  );

  for (const element of bundle.layout.elements.filter((candidate) => candidate.visible)) {
    const overflowRight = Math.max(
      0,
      Math.ceil(element.bounds.x + element.bounds.width - viewportWidth),
    );
    if (overflowRight > 0) {
      const label = describeElement(element);
      findings.push(createFinding({
        findingId: 'df_overflow',
        severity: overflowRight > 16 ? 'high' : overflowRight > 4 ? 'medium' : 'low',
        category: 'overflow',
        summary: `${label} overflows the viewport by ${overflowRight}px at ${viewportWidth}px width.`,
        evidenceReferences: [`${bundle.layoutPath}:${element.elementId}`],
        unstable: bundle.unstable,
      }));
    }

    const matchingStyle = stylesByIdentity.get(layoutIdentity(element));
    if (
      matchingStyle &&
      (matchingStyle.scrollWidth > matchingStyle.clientWidth + 1 ||
        matchingStyle.scrollHeight > matchingStyle.clientHeight + 1)
    ) {
      const clippedLabel = normalizeClippingLabel(element);
      findings.push(createFinding({
        findingId: 'df_clip',
        severity: 'medium',
        category: 'clipping',
        summary: `${clippedLabel} is clipped on the right edge.`,
        evidenceReferences: [`${bundle.layoutPath}:${element.elementId}`],
        unstable: bundle.unstable,
      }));
    }
  }

  const visibleElements = bundle.layout.elements.filter((element) => element.visible);
  for (let index = 0; index < visibleElements.length; index += 1) {
    const current = visibleElements[index];
    if (!current) {
      continue;
    }

    for (let nestedIndex = index + 1; nestedIndex < visibleElements.length; nestedIndex += 1) {
      const comparison = visibleElements[nestedIndex];
      if (!comparison) {
        continue;
      }

      const overlapWidth = Math.min(
        current.bounds.x + current.bounds.width,
        comparison.bounds.x + comparison.bounds.width,
      ) - Math.max(current.bounds.x, comparison.bounds.x);
      const overlapHeight = Math.min(
        current.bounds.y + current.bounds.height,
        comparison.bounds.y + comparison.bounds.height,
      ) - Math.max(current.bounds.y, comparison.bounds.y);

      if (overlapWidth > 8 && overlapHeight > 8) {
        if (fullyContains(current, comparison) || fullyContains(comparison, current)) {
          continue;
        }

        findings.push(createFinding({
          findingId: 'df_overlap',
          severity: 'high',
          category: 'overlap',
          summary: `${describeElement(current)} overlaps ${describeElement(comparison)} in the captured layout.`,
          evidenceReferences: [
            `${bundle.layoutPath}:${current.elementId}`,
            `${bundle.layoutPath}:${comparison.elementId}`,
          ],
          unstable: bundle.unstable,
        }));
        break;
      }
    }
  }

  return dedupeFindings(findings);
}

function layoutIdentity(element: DesignAuditBundle['layout']['elements'][number]): string {
  return [
    element.selectorHints.id ?? '',
    element.selectorHints.testId ?? '',
    element.name,
    element.role,
  ].join('|');
}

function styleIdentity(
  element: NonNullable<NonNullable<DesignAuditBundle['styles']>['elements']>[number],
): string {
  return [
    element.id ?? '',
    element.testId ?? '',
    element.name,
    element.role,
  ].join('|');
}

function dedupeFindings(findings: DesignFinding[]): DesignFinding[] {
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

function normalizeClippingLabel(
  element: DesignAuditBundle['layout']['elements'][number],
): string {
  const label = describeElement(element);
  if (label.endsWith(' CTA')) {
    return `${label} label`;
  }

  return label;
}
