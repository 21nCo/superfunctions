import { createFinding, type DesignAuditBundle, type DesignFinding } from './shared.js';

export function analyzeFocusStates(
  bundle: DesignAuditBundle,
): DesignFinding[] {
  const findings: DesignFinding[] = [];

  for (const element of bundle.styles?.elements ?? []) {
    if (
      element.visible === false ||
      !element.focusable ||
      element.focusIndicatorVisible ||
      !isPriorityControl(element)
    ) {
      continue;
    }

    findings.push(createFinding({
      findingId: 'df_focus',
      severity: 'medium',
      category: 'focus-state',
      summary: `Focused ${element.name || element.text || element.id || element.role} has no visible outline.`,
      evidenceReferences: [bundle.checkpointPath],
      unstable: bundle.unstable,
    }));
  }

  return findings;
}

function isPriorityControl(
  element: NonNullable<NonNullable<DesignAuditBundle['styles']>['elements']>[number],
): boolean {
  const identity = [
    element.id,
    element.testId,
    element.name,
    element.text,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return /\b(cta|action|primary|secondary)\b/.test(identity);
}
