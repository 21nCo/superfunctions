import { defineComponent, h, PropType, toRefs, provide, inject, ref, watch, onUnmounted, Teleport } from 'vue';
import { useControllableState } from './hooks/use-controllable-state';
import { generateId } from '@uifn/core/utils/id';

/* -------------------------------------------------------------------------------------------------
 * Dialog Root
 * -----------------------------------------------------------------------------------------------*/

const DialogSymbol = Symbol('Dialog');

interface DialogContext {
  open: any;
  onOpenChange: (val: boolean) => void;
  modal: boolean;
  titleId: any;
  descriptionId: any;
  setTitleId: (id: string) => void;
  setDescriptionId: (id: string) => void;
}

export const Dialog = defineComponent({
  name: 'Dialog',
  props: {
    open: {
      type: Boolean as PropType<boolean>,
      default: undefined
    },
    defaultOpen: {
      type: Boolean,
      default: false
    },
    modal: {
      type: Boolean,
      default: true
    }
  },
  emits: ['update:open', 'openChange'],
  setup(props, { slots, emit }) {
    const { open: openProp, defaultOpen, modal } = toRefs(props);

    const open = useControllableState({
      prop: openProp,
      defaultProp: defaultOpen.value,
      emit,
      name: 'open'
    });

    const titleId = ref<string>();
    const descriptionId = ref<string>();

    provide(DialogSymbol, {
      open,
      onOpenChange: (val: boolean) => {
        open.value = val;
      },
      modal: modal.value,
      titleId,
      descriptionId,
      setTitleId: (id: string) => titleId.value = id,
      setDescriptionId: (id: string) => descriptionId.value = id
    });

    return () => slots.default?.();
  }
});

/* -------------------------------------------------------------------------------------------------
 * Dialog Trigger
 * -----------------------------------------------------------------------------------------------*/

export const DialogTrigger = defineComponent({
  name: 'DialogTrigger',
  setup(_, { slots }) {
    const context = inject<DialogContext>(DialogSymbol);
    if (!context) throw new Error('DialogTrigger must be used within Dialog');

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
 * Dialog Portal
 * -----------------------------------------------------------------------------------------------*/

export const DialogPortal = defineComponent({
  name: 'DialogPortal',
  props: {
    to: {
      type: [String, Object] as PropType<string | HTMLElement>,
      default: 'body'
    },
    forceMount: Boolean
  },
  setup(props, { slots }) {
    const context = inject<DialogContext>(DialogSymbol);
    if (!context) throw new Error('DialogPortal must be used within Dialog');

    return () => {
      if (!context.open.value && !props.forceMount) return null;
      return h(Teleport as any, { to: props.to }, slots.default?.());
    };
  }
});

/* -------------------------------------------------------------------------------------------------
 * Dialog Overlay
 * -----------------------------------------------------------------------------------------------*/

export const DialogOverlay = defineComponent({
  name: 'DialogOverlay',
  setup(_props, { slots }) {
    const context = inject<DialogContext>(DialogSymbol);
    if (!context) throw new Error('DialogOverlay must be used within Dialog');

    return () => h('div', {
      'data-state': context.open.value ? 'open' : 'closed',
      style: {
        position: 'fixed',
        inset: 0,
        zIndex: 50,
        backgroundColor: 'rgba(0,0,0,0.5)'
      }
    }, slots.default?.());
  }
});

/* -------------------------------------------------------------------------------------------------
 * Dialog Content
 * -----------------------------------------------------------------------------------------------*/

export const DialogContent = defineComponent({
  name: 'DialogContent',
  emits: ['escapeKeyDown', 'pointerDownOutside', 'interactOutside'],
  setup(_props, { slots, emit }) {
    const context = inject<DialogContext>(DialogSymbol);
    if (!context) throw new Error('DialogContent must be used within Dialog');
    
    const contentRef = ref<HTMLElement | null>(null);

    // Focus Trap & Outside Click & Escape would usually be composables here
    // Implementing basic Escape logic directly for now
    
    const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
            emit('escapeKeyDown', e);
            if (!e.defaultPrevented) {
                context.onOpenChange(false);
            }
        }
    };

    watch(() => context.open.value, (isOpen) => {
        if (typeof window === 'undefined') return;
        if (isOpen) {
            window.addEventListener('keydown', handleKeyDown);
            // Basic Focus Trap mock
            requestAnimationFrame(() => {
                contentRef.value?.focus();
            });
        } else {
            window.removeEventListener('keydown', handleKeyDown);
        }
    });

    onUnmounted(() => {
        if (typeof window !== 'undefined') window.removeEventListener('keydown', handleKeyDown);
    });

    return () => h('div', {
      ref: contentRef,
      role: 'dialog',
      id: 'dialog-content',
      'aria-describedby': context.descriptionId.value,
      'aria-labelledby': context.titleId.value,
      'aria-modal': context.modal,
      'data-state': context.open.value ? 'open' : 'closed',
      tabIndex: -1,
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
    }, slots.default?.());
  }
});

/* -------------------------------------------------------------------------------------------------
 * Dialog Title
 * -----------------------------------------------------------------------------------------------*/

export const DialogTitle = defineComponent({
  name: 'DialogTitle',
  setup(_, { slots }) {
    const context = inject<DialogContext>(DialogSymbol);
    const id = generateId();
    if (context) context.setTitleId(id);

    return () => h('h2', { id }, slots.default?.());
  }
});

/* -------------------------------------------------------------------------------------------------
 * Dialog Description
 * -----------------------------------------------------------------------------------------------*/

export const DialogDescription = defineComponent({
  name: 'DialogDescription',
  setup(_, { slots }) {
    const context = inject<DialogContext>(DialogSymbol);
    const id = generateId();
    if (context) context.setDescriptionId(id);

    return () => h('p', { id }, slots.default?.());
  }
});

/* -------------------------------------------------------------------------------------------------
 * Dialog Close
 * -----------------------------------------------------------------------------------------------*/

export const DialogClose = defineComponent({
  name: 'DialogClose',
  setup(_, { slots }) {
    const context = inject<DialogContext>(DialogSymbol);
    if (!context) throw new Error('DialogClose must be used within Dialog');

    return () => h('button', {
      type: 'button',
      onClick: () => context.onOpenChange(false)
    }, slots.default?.());
  }
});
