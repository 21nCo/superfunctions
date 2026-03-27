export function isOutsideEventTarget(
  target: Node | null,
  elements: Array<HTMLElement | null | undefined>
): boolean {
  if (!target) {
    return true;
  }

  return elements.every((element) => !element?.contains(target));
}
