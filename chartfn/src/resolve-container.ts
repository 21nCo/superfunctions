export const resolveContainer = (
  container: HTMLElement | string,
): HTMLElement | null => {
  if (typeof container === "string") {
    if (typeof document === "undefined") {
      return null;
    }
    try { return document.querySelector(container); } catch { return null; }
  }

  return container;
};
