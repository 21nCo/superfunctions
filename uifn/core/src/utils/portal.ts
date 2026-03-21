export type PortalTarget = HTMLElement | string | null | undefined;

export interface PortalMountController {
  update: (target?: PortalTarget) => void;
  destroy: () => void;
  getTarget: () => HTMLElement | null;
}

export function resolvePortalTarget(
  target: PortalTarget,
  ownerDocument: Document
): HTMLElement | null {
  if (!target) {
    return ownerDocument.body;
  }

  if (typeof target === 'string') {
    return ownerDocument.querySelector(target);
  }

  return target;
}

export function createPortalMount(
  node: HTMLElement,
  target: PortalTarget = 'body',
  ownerDocument: Document = node.ownerDocument
): PortalMountController {
  let targetNode = resolvePortalTarget(target, ownerDocument);

  const append = () => {
    if (!targetNode) {
      return;
    }

    if (node.parentElement !== targetNode) {
      targetNode.appendChild(node);
    }
  };

  const remove = () => {
    if (node.parentNode) {
      node.parentNode.removeChild(node);
    }
  };

  append();

  return {
    update(nextTarget) {
      targetNode = resolvePortalTarget(nextTarget, ownerDocument);
      append();
    },
    destroy() {
      remove();
    },
    getTarget() {
      return targetNode;
    },
  };
}
