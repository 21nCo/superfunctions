export function getEnabledCollectionItems(
  container: ParentNode | null | undefined,
  selector: string
): HTMLElement[] {
  if (!container) {
    return [];
  }

  return Array.from(container.querySelectorAll<HTMLElement>(selector)).filter(
    (item) => !item.hasAttribute('disabled') && item.getAttribute('aria-disabled') !== 'true'
  );
}

export function focusCollectionItemByIndex(
  container: ParentNode | null | undefined,
  selector: string,
  index: number
): HTMLElement | null {
  const items = getEnabledCollectionItems(container, selector);
  const target = items[index] ?? null;
  target?.focus();
  return target;
}

export function focusCollectionItemByDirection(
  container: ParentNode | null | undefined,
  selector: string,
  current: HTMLElement | null,
  direction: 'next' | 'prev' | 'first' | 'last'
): HTMLElement | null {
  const items = getEnabledCollectionItems(container, selector);
  if (items.length === 0) {
    return null;
  }

  if (direction === 'first') {
    return focusCollectionItemByIndex(container, selector, 0);
  }

  if (direction === 'last') {
    return focusCollectionItemByIndex(container, selector, items.length - 1);
  }

  const currentIndex = current ? items.indexOf(current) : -1;
  const nextIndex =
    direction === 'next'
      ? (currentIndex + 1 + items.length) % items.length
      : (currentIndex - 1 + items.length) % items.length;

  return focusCollectionItemByIndex(container, selector, nextIndex < 0 ? 0 : nextIndex);
}

export function focusElementById(
  container: ParentNode | null | undefined,
  id: string | null | undefined
): HTMLElement | null {
  if (!container || !id) {
    return null;
  }

  const element = container.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
  element?.focus();
  return element ?? null;
}
