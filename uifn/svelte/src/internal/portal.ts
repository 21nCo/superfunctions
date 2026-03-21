import { createPortalMount } from '@uifn/core/utils/portal';

export function portal(node: HTMLElement, target: HTMLElement | string = 'body') {
  const portalMount = createPortalMount(node, target);

  return {
    update(newTarget: HTMLElement | string) {
      portalMount.update(newTarget);
    },
    destroy() {
      portalMount.destroy();
    }
  };
}
