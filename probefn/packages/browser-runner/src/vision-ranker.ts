import type { Page } from 'playwright';

import type { SemanticCandidate } from './semantic-find.js';

export interface VisionRankedCandidate {
  candidate: SemanticCandidate;
  visionScore: number;
  combinedScore: number;
}

export async function rankVisionCandidates(
  page: Page,
  query: string,
  candidates: SemanticCandidate[],
): Promise<VisionRankedCandidate[]> {
  const viewport = page.viewportSize() ?? { width: 0, height: 0 };
  await page.screenshot({
    fullPage: false,
  });

  const queryTerms = normalizeValue(query);
  const viewportCenterX = viewport.width / 2;
  const viewportCenterY = viewport.height / 2;
  const maxDistance = Math.max(
    Math.hypot(viewportCenterX, viewportCenterY),
    1,
  );
  const queryPrefersPrimaryPlacement =
    queryTerms.includes('primary') || queryTerms.includes('cta');

  return [...candidates]
    .map((candidate) => {
      const centerX = candidate.element.bounds.x + candidate.element.bounds.width / 2;
      const centerY = candidate.element.bounds.y + candidate.element.bounds.height / 2;
      const distanceToCenter = Math.hypot(centerX - viewportCenterX, centerY - viewportCenterY);
      const centralityScore = Math.max(0, 1 - distanceToCenter / maxDistance) * 100;
      const areaRatio =
        viewport.width > 0 && viewport.height > 0
          ? (candidate.element.bounds.width * candidate.element.bounds.height) /
            (viewport.width * viewport.height)
          : 0;
      const prominenceScore = Math.min(areaRatio, 1) * 25;
      const primaryPlacementScore = queryPrefersPrimaryPlacement
        ? Math.max(0, 1 - Math.abs(centerY - viewport.height * 0.4) / Math.max(viewport.height, 1)) * 20
        : 0;
      const visionScore = centralityScore + prominenceScore + primaryPlacementScore;

      return {
        candidate,
        visionScore,
        combinedScore: candidate.semanticScore * 1000 + visionScore,
      };
    })
    .sort((left, right) => right.combinedScore - left.combinedScore);
}

function normalizeValue(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}
