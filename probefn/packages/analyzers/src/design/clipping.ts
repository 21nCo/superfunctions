import { createFinding, type DesignAuditBundle, type DesignFinding } from './shared.js';

export function analyzeClippingFallback(
  bundle: DesignAuditBundle,
): DesignFinding[] {
  const findings: DesignFinding[] = [];
  for (const element of bundle.styles?.elements ?? []) {
    if (element.visible === false) {
      continue;
    }

    if (
      ((element.overflowX === 'hidden')
        && (element.textOverflow !== 'clip' || element.scrollWidth > element.clientWidth + 1))
      || ((element.overflowY === 'hidden')
        && element.scrollHeight > element.clientHeight + 1)
    ) {
      findings.push(createFinding({
        findingId: 'df_clip',
        severity: 'medium',
        category: 'clipping',
        summary: `${element.name || element.text || element.id || element.role} has clipped content in its rendered box.`,
        evidenceReferences: [bundle.checkpointPath],
        unstable: bundle.unstable,
      }));
    }
  }

  return findings;
}
