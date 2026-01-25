export function portal(node: HTMLElement, target: HTMLElement | string = 'body') {
  let targetNode: Element | null = null;
  
  function update(newTarget: HTMLElement | string) {
    targetNode = typeof newTarget === 'string' ? document.querySelector(newTarget) : newTarget;
    if (targetNode) {
      targetNode.appendChild(node);
    }
  }

  update(target);

  return {
    update,
    destroy() {
      if (node.parentNode) {
        node.parentNode.removeChild(node);
      }
    }
  };
}
