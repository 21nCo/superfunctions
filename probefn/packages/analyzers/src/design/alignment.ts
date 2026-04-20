import { createFinding, type DesignAuditBundle, type DesignFinding } from './shared.js';

export function analyzeAlignment(
  bundle: DesignAuditBundle,
): DesignFinding[] {
  const interactiveElements = bundle.layout.elements
    .filter((element) => element.visible && ['button', 'textbox', 'combobox', 'link'].includes(element.role))
    .slice(0, 8);

  if (interactiveElements.length < 3) {
    return [];
  }

  const leftEdges = interactiveElements.map((element) => Math.round(element.bounds.x));
  const minLeft = Math.min(...leftEdges);
  const maxLeft = Math.max(...leftEdges);
  const drift = maxLeft - minLeft;
  if (drift <= 12) {
    return [];
  }

  return [
    createFinding({
      findingId: 'df_alignment',
      severity: drift > 24 ? 'medium' : 'low',
      category: 'alignment',
      summary: `Interactive elements drift by ${drift}px on their left edge alignment.`,
      evidenceReferences: [bundle.layoutPath],
      unstable: bundle.unstable,
    }),
  ];
}
