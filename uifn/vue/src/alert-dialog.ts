import { defineComponent, h, toRefs, provide, inject } from 'vue';
import { useControllableState } from './hooks/use-controllable-state';
import { DialogPortal } from './dialog';

/* -------------------------------------------------------------------------------------------------
 * AlertDialog Root
 * -----------------------------------------------------------------------------------------------*/

export const AlertDialog = defineComponent({
  name: 'AlertDialog',
  props: {
    open: { type: Boolean, default: undefined },
    defaultOpen: { type: Boolean, default: false }
  },
  emits: ['update:open', 'openChange'],
  setup(props, { slots, emit }) {
    // Re-export Dialog but could also compose it if needed.
    // For Vue, we can just use Dialog implementation with different roles if the Dialog component supports it.
    // But our Dialog component hardcodes role="dialog".
    // So we might need to duplicate or make Dialog flexible.
    
    // For simplicity in this codebase structure, I'll compose/wrap logic similar to React but adapted for Vue.
    // Actually, looking at `src/vue/dialog.ts`, it hardcodes role="dialog".
    // I will implement AlertDialog separately but reusing hooks.
    
    const { open: openProp, defaultOpen } = toRefs(props);
    const open = useControllableState({
      prop: openProp,
      defaultProp: defaultOpen.value,
      emit,
      name: 'open'
    });

    provide('AlertDialog', {
      open,
      onOpenChange: (val: boolean) => { open.value = val; }
    });

    return () => slots.default?.();
  }
});

/* -------------------------------------------------------------------------------------------------
 * AlertDialog Trigger
 * -----------------------------------------------------------------------------------------------*/

export const AlertDialogTrigger = defineComponent({
  name: 'AlertDialogTrigger',
  setup(_, { slots }) {
    const context = inject<any>('AlertDialog');
    return () => h('button', {
      type: 'button',
      'aria-haspopup': 'dialog',
      'aria-expanded': context.open.value,
      'data-state': context.open.value ? 'open' : 'closed',
      onClick: () => context.onOpenChange(true)
    }, slots.default?.());
  }
});

/* -------------------------------------------------------------------------------------------------
 * AlertDialog Portal & Overlay
 * -----------------------------------------------------------------------------------------------*/

export const AlertDialogPortal = DialogPortal; // Reuse if generic enough, else duplicate.
// DialogPortal in vue/dialog.ts uses Teleport. It expects nothing special context-wise?
// Actually DialogPortal checks `context.open`. So we cannot reuse strictly if we use different symbol.
// Let's duplicated simple portal for AlertDialog.

import { Teleport } from 'vue';

export const AlertDialogOverlay = defineComponent({
  name: 'AlertDialogOverlay',
  setup(_, { slots }) {
    const context = inject<any>('AlertDialog');
    if (!context.open.value) return () => null;

    return () => h(Teleport, { to: 'body' }, [
      h('div', {
        'data-state': context.open.value ? 'open' : 'closed',
        style: {
          position: 'fixed',
          inset: 0,
          zIndex: 50,
          backgroundColor: 'rgba(0,0,0,0.5)'
        }
      }, slots.default?.())
    ]);
  }
});

/* -------------------------------------------------------------------------------------------------
 * AlertDialog Content
 * -----------------------------------------------------------------------------------------------*/

import { useFocusTrap } from './hooks/use-focus-trap';
import { useBodyScrollLock } from './hooks/use-body-scroll-lock';
import { useEscapeKeydown } from './hooks/use-escape-keydown';
import { ref } from 'vue';

export const AlertDialogContent = defineComponent({
  name: 'AlertDialogContent',
  setup(_, { slots }) {
    const context = inject<any>('AlertDialog');
    const contentRef = ref<HTMLElement>();

    useFocusTrap(contentRef, context.open, { returnFocus: true });
    useBodyScrollLock(context.open);
    useEscapeKeydown(() => {
        if (context.open.value) {
            // AlertDialog usually forces user action, but Escape usually cancels.
            context.onOpenChange(false);
        }
    });

    return () => {
        if (!context.open.value) return null;
        return h(Teleport, { to: 'body' }, [
            h('div', {
                ref: contentRef,
                role: 'alertdialog',
                'aria-modal': 'true',
                'data-state': context.open.value ? 'open' : 'closed',
                style: {
                    position: 'fixed',
                    top: '50%',
                    left: '50%',
                    transform: 'translate(-50%, -50%)',
                    zIndex: 51,
                    backgroundColor: 'white',
                    padding: '20px',
                    borderRadius: '4px'
                }
            }, slots.default?.())
        ]);
    };
  }
});

/* -------------------------------------------------------------------------------------------------
 * AlertDialog Parts
 * -----------------------------------------------------------------------------------------------*/

export const AlertDialogTitle = defineComponent({
  name: 'AlertDialogTitle',
  setup(_, { slots }) {
    return () => h('h2', {}, slots.default?.());
  }
});

export const AlertDialogDescription = defineComponent({
  name: 'AlertDialogDescription',
  setup(_, { slots }) {
    return () => h('p', {}, slots.default?.());
  }
});

export const AlertDialogAction = defineComponent({
  name: 'AlertDialogAction',
  setup(_, { slots }) {
    const context = inject<any>('AlertDialog');
    return () => h('button', {
        type: 'button',
        onClick: () => context.onOpenChange(false) // Assuming action confirms and closes
    }, slots.default?.());
  }
});

export const AlertDialogCancel = defineComponent({
  name: 'AlertDialogCancel',
  setup(_, { slots }) {
    const context = inject<any>('AlertDialog');
    return () => h('button', {
        type: 'button',
        onClick: () => context.onOpenChange(false)
    }, slots.default?.());
  }
});
