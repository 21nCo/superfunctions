import { createFinding, type DesignAuditBundle, type DesignFinding } from './shared.js';

export function analyzeResponsive(
  bundle: DesignAuditBundle,
  seedFindings: DesignFinding[],
): DesignFinding[] {
  if (bundle.viewport.width > 820) {
    return [];
  }

  const responsiveCategories = new Set(['overflow', 'clipping', 'overlap']);
  const responsiveIssues = seedFindings.filter((finding) => responsiveCategories.has(finding.category));
  if (responsiveIssues.length === 0) {
    return [];
  }

  return [
    createFinding({
      findingId: 'df_responsive',
      severity: responsiveIssues.some((finding) => finding.severity === 'high') ? 'high' : 'medium',
      category: 'responsive',
      summary: `Responsive layout degrades at ${bundle.viewport.width}px width with ${responsiveIssues.length} blocking layout issue(s).`,
      evidenceReferences: [bundle.layoutPath],
      unstable: bundle.unstable,
    }),
  ];
}
