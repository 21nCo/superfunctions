export const resolveContainer = (
  container: HTMLElement | string,
): HTMLElement | null => {
  if (typeof container === "string") {
    if (typeof document === "undefined") {
      return null;
    }
    return document.querySelector(container);
  }

  return container;
};
