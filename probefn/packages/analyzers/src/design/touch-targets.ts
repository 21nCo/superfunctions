import { createFinding, type DesignAuditBundle, type DesignFinding } from './shared.js';

const TOUCH_ROLES = new Set(['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem']);

export function analyzeTouchTargets(
  bundle: DesignAuditBundle,
): DesignFinding[] {
  const findings: DesignFinding[] = [];

  for (const element of bundle.styles?.elements ?? []) {
    if (element.visible === false || !TOUCH_ROLES.has(element.role)) {
      continue;
    }

    const tooNarrow = element.bounds.width < 44;
    const tooShort = element.bounds.height < 44;
    if (!tooNarrow && !tooShort) {
      continue;
    }

    findings.push(createFinding({
      findingId: 'df_touch',
      severity: element.bounds.width < 36 || element.bounds.height < 36 ? 'medium' : 'low',
      category: 'touch-target',
      summary: `${element.name || element.text || element.id || element.role} is only ${Math.round(element.bounds.width)}x${Math.round(element.bounds.height)}px and falls below the 44x44 touch target guideline.`,
      evidenceReferences: [bundle.checkpointPath],
      unstable: bundle.unstable,
    }));
  }

  return findings;
}
