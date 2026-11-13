import { focusUIFnElement } from '@uifn/dom';
import type { SvelteCommitFocus } from './compound.js';

/**
 * Svelte commits action parameters after controller subscribers run, so Menubar's roving focus would otherwise
 * move before the new active item and its roving tabindex reach the DOM. The generated Menubar definition lists
 * this hook; the bridge runs it for the live controller only.
 */
export const svelteMenubarCommitFocus: SvelteCommitFocus = (bridge, controller) => {
  let wasOpen = Boolean(controller.getState().value);
  let cancelPending: (() => void) | null = null;
  let destroyed = false;

  const focusAfterCommit = (root: HTMLElement) => {
    cancelPending = null;
    if (destroyed) return;
    const current = controller.getState();
    const open = Boolean(current.value);
    const activeKey = String(open ? current.activeItem ?? '' : current.focusReturn ?? current.focusedMenu ?? '');
    if (!activeKey) return;
    const parts = open ? ['item', 'submenuTrigger'] : ['trigger'];
    const target = parts
      .map((part) => bridge.getElement(part, activeKey))
      .find((element): element is HTMLElement => Boolean(element))
      ?? (open ? bridge.getElementEntries('item').find(({ element }) => element.tabIndex === 0)?.element : null);
    if (target?.isConnected && root.ownerDocument.activeElement !== target) target.focus({ preventScroll: true });
  };

  return {
    /** Defers the focus transfer for an open menubar, or the restore after it closes, until the next frame. */
    changed() {
      const root = bridge.getElement(bridge.definition.rootPart);
      if (destroyed || !root) return;
      const open = Boolean(controller.getState().value);
      const shouldRestore = wasOpen && !open;
      wasOpen = open;
      if (!open && !shouldRestore) return;
      cancelPending?.();
      const ownerWindow = root.ownerDocument.defaultView;
      if (!ownerWindow) return;
      if (typeof ownerWindow.requestAnimationFrame === 'function') {
        const frame = ownerWindow.requestAnimationFrame(() => focusAfterCommit(root));
        cancelPending = () => ownerWindow.cancelAnimationFrame(frame);
      } else {
        const timer = ownerWindow.setTimeout(() => focusAfterCommit(root), 0);
        cancelPending = () => ownerWindow.clearTimeout(timer);
      }
    },
    /** Once a DOM commit lands, focuses the open menubar's active item. */
    committed() {
      if (destroyed) return;
      const state = controller.getState();
      const activeItem = state.value ? String(state.activeItem ?? '') : '';
      const target = activeItem
        ? bridge.getElement('item', activeItem) ?? bridge.getElement('submenuTrigger', activeItem)
        : null;
      if (target?.isConnected) focusUIFnElement(target);
    },
    destroy() {
      destroyed = true;
      cancelPending?.();
      cancelPending = null;
    },
  };
};
