import { createFocusTrap } from '@uifn/core/utils/focus-trap';

export function focusTrap(node: HTMLElement, options: { active: boolean; returnFocus?: boolean } = { active: true, returnFocus: true }) {
  const focusTrapController = createFocusTrap(node, {
    active: options.active,
    returnFocus: options.returnFocus,
  });

  return {
    update(newOptions: { active: boolean; returnFocus?: boolean }) {
      options = newOptions;
      focusTrapController.update({
        active: newOptions.active,
        returnFocus: newOptions.returnFocus,
      });
    },
    destroy() {
      focusTrapController.destroy();
    }
  };
}
