import type { Locator } from 'playwright';

export interface DomConfirmationResult {
  ok: boolean;
  reason: string;
  point: {
    x: number;
    y: number;
  } | null;
  hitTag: string | null;
}

export async function confirmDomInteractable(
  locator: Locator,
): Promise<DomConfirmationResult> {
  const boundingBox = await locator.boundingBox();
  if (!boundingBox) {
    return {
      ok: false,
      reason: 'Target did not expose a DOM bounding box.',
      point: null,
      hitTag: null,
    };
  }

  const confirmationPoint = {
    x: Math.max(boundingBox.x + boundingBox.width / 2, 0),
    y: Math.max(boundingBox.y + boundingBox.height / 2, 0),
  };

  return locator.evaluate((element, point) => {
    const style = window.getComputedStyle(element);
    const visible =
      style.visibility !== 'hidden' &&
      style.display !== 'none' &&
      Number(style.opacity || '1') > 0;
    const disabled =
      'disabled' in element &&
      Boolean((element as HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).disabled);
    const hitTarget = document.elementFromPoint(point.x, point.y);
    const structurallyConfirmed =
      hitTarget === element ||
      (hitTarget !== null && element.contains(hitTarget));

    if (!visible) {
      return {
        ok: false,
        reason: 'Target is not visible in the DOM.',
        point,
        hitTag: hitTarget?.tagName.toLowerCase() ?? null,
      };
    }

    if (disabled) {
      return {
        ok: false,
        reason: 'Target is disabled.',
        point,
        hitTag: hitTarget?.tagName.toLowerCase() ?? null,
      };
    }

    if (!structurallyConfirmed) {
      return {
        ok: false,
        reason: 'Another element is covering the target.',
        point,
        hitTag: hitTarget?.tagName.toLowerCase() ?? null,
      };
    }

    return {
      ok: true,
      reason: 'confirmed',
      point,
      hitTag: hitTarget?.tagName.toLowerCase() ?? null,
    };
  }, confirmationPoint);
}
