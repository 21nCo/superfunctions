import { defineComponent, h, toRefs, provide, inject, Ref, watch, Teleport } from 'vue';
import { useControllableState } from './hooks/use-controllable-state';

/* -------------------------------------------------------------------------------------------------
 * Toast Root
 * -----------------------------------------------------------------------------------------------*/

const ToastSymbol = Symbol('Toast');

interface ToastContext {
  open: Ref<boolean>;
  onOpenChange: (val: boolean) => void;
}

export const Toast = defineComponent({
  name: 'Toast',
  props: {
    open: {
      type: Boolean,
      default: undefined
    },
    defaultOpen: {
      type: Boolean,
      default: true
    },
    duration: {
      type: Number,
      default: 5000
    }
  },
  emits: ['update:open', 'openChange'],
  setup(props, { slots, emit }) {
    const { open: openProp, defaultOpen, duration } = toRefs(props);

    const open = useControllableState({
      prop: openProp,
      defaultProp: defaultOpen.value,
      emit,
      name: 'open'
    });

    let timer: any;

    const startTimer = () => {
      if (duration.value === Infinity) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        open.value = false;
      }, duration.value);
    };

    watch(open, (val) => {
      if (val) startTimer();
      else clearTimeout(timer);
    }, { immediate: true });

    provide(ToastSymbol, {
      open,
      onOpenChange: (val: boolean) => { open.value = val; }
    });

    return () => {
      if (!open.value) return null;

      return h('li', {
        role: 'status',
        'aria-live': 'polite',
        'aria-atomic': 'true',
        'data-state': 'open',
        onMouseenter: () => clearTimeout(timer),
        onMouseleave: startTimer,
        style: {
          backgroundColor: 'white',
          borderRadius: '6px',
          boxShadow: '0 10px 38px -10px rgba(22, 23, 24, 0.35)',
          padding: '15px',
          display: 'grid',
          gridTemplateAreas: '"title action" "description action"',
          gridTemplateColumns: 'auto max-content',
          columnGap: '15px',
          alignItems: 'center'
        }
      }, slots.default?.());
    };
  }
});

/* -------------------------------------------------------------------------------------------------
 * Toast Provider (Simplified)
 * -----------------------------------------------------------------------------------------------*/

export const ToastProvider = defineComponent({
  name: 'ToastProvider',
  setup(_, { slots }) {
    return () => slots.default?.();
  }
});

/* -------------------------------------------------------------------------------------------------
 * Toast Viewport
 * -----------------------------------------------------------------------------------------------*/

export const ToastViewport = defineComponent({
  name: 'ToastViewport',
  setup(_, { slots }) {
    return () => h(Teleport, { to: 'body' }, [
      h('ol', {
        role: 'region',
        'aria-label': 'Notifications',
        style: {
          position: 'fixed',
          bottom: '0',
          right: '0',
          display: 'flex',
          flexDirection: 'column',
          padding: '25px',
          gap: '10px',
          width: '390px',
          maxWidth: '100vw',
          margin: '0',
          listStyle: 'none',
          zIndex: 2147483647,
          outline: 'none'
        }
      }, slots.default?.())
    ]);
  }
});

/* -------------------------------------------------------------------------------------------------
 * Toast Parts
 * -----------------------------------------------------------------------------------------------*/

export const ToastTitle = defineComponent({
  name: 'ToastTitle',
  setup(_, { slots }) {
    return () => h('div', {
      style: { gridArea: 'title', marginBottom: '5px', fontWeight: '500' }
    }, slots.default?.());
  }
});

export const ToastDescription = defineComponent({
  name: 'ToastDescription',
  setup(_, { slots }) {
    return () => h('div', {
      style: { gridArea: 'description', margin: '0', opacity: '0.8', fontSize: '13px' }
    }, slots.default?.());
  }
});

export const ToastAction = defineComponent({
  name: 'ToastAction',
  props: {
    altText: { type: String, required: true }
  },
  setup(_, { slots }) {
    return () => h('button', {
      type: 'button',
      style: { gridArea: 'action' }
    }, slots.default?.());
  }
});

export const ToastClose = defineComponent({
  name: 'ToastClose',
  setup(_, { slots }) {
    const context = inject<ToastContext>(ToastSymbol);
    return () => h('button', {
      type: 'button',
      onClick: () => context?.onOpenChange(false)
    }, slots.default?.());
  }
});
