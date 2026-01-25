import { defineComponent, h, PropType, toRefs, provide, inject, ref, Teleport, Ref } from 'vue';
import { useControllableState } from './hooks/use-controllable-state';
import { usePosition, Side, Align } from './hooks/use-position';

/* -------------------------------------------------------------------------------------------------
 * Tooltip Root
 * -----------------------------------------------------------------------------------------------*/

const TooltipSymbol = Symbol('Tooltip');

interface TooltipContext {
  open: Ref<boolean>;
  onOpenChange: (val: boolean) => void;
  triggerRef: Ref<HTMLElement | undefined>;
  contentRef: Ref<HTMLElement | undefined>;
  openWithDelay: () => void;
  close: () => void;
}

export const Tooltip = defineComponent({
  name: 'Tooltip',
  props: {
    open: {
      type: Boolean,
      default: undefined
    },
    defaultOpen: {
      type: Boolean,
      default: false
    },
    delayDuration: {
      type: Number,
      default: 700
    }
  },
  emits: ['update:open', 'openChange'],
  setup(props, { slots, emit }) {
    const { open: openProp, defaultOpen, delayDuration } = toRefs(props);

    const open = useControllableState({
      prop: openProp,
      defaultProp: defaultOpen.value,
      emit,
      name: 'open'
    });

    const triggerRef = ref<HTMLElement>();
    const contentRef = ref<HTMLElement>();
    let timeout: any;

    const openWithDelay = () => {
      clearTimeout(timeout);
      if (delayDuration.value <= 0) {
        open.value = true;
      } else {
        timeout = setTimeout(() => {
          open.value = true;
        }, delayDuration.value);
      }
    };

    const close = () => {
      clearTimeout(timeout);
      open.value = false;
    };

    provide(TooltipSymbol, {
      open,
      onOpenChange: (val: boolean) => { open.value = val; },
      triggerRef,
      contentRef,
      openWithDelay,
      close
    });

    return () => {
      return slots.default?.();
    };
  }
});

/* -------------------------------------------------------------------------------------------------
 * Tooltip Trigger
 * -----------------------------------------------------------------------------------------------*/

export const TooltipTrigger = defineComponent({
  name: 'TooltipTrigger',
  setup(_, { slots }) {
    const context = inject<TooltipContext>(TooltipSymbol);
    if (!context) throw new Error('TooltipTrigger must be used within Tooltip');

    return () => h('button', {
      type: 'button',
      ref: context.triggerRef,
      'data-state': context.open.value ? 'delayed-open' : 'closed',
      onMouseenter: context.openWithDelay,
      onMouseleave: context.close,
      onFocus: context.openWithDelay,
      onBlur: context.close
    }, slots.default?.());
  }
});

/* -------------------------------------------------------------------------------------------------
 * Tooltip Content
 * -----------------------------------------------------------------------------------------------*/

export const TooltipContent = defineComponent({
  name: 'TooltipContent',
  props: {
    side: {
      type: String as PropType<Side>,
      default: 'top'
    },
    align: {
      type: String as PropType<Align>,
      default: 'center'
    },
    sideOffset: {
      type: Number,
      default: 5
    },
    alignOffset: {
      type: Number,
      default: 0
    }
  },
  setup(props, { slots }) {
    const context = inject<TooltipContext>(TooltipSymbol);
    if (!context) throw new Error('TooltipContent must be used within Tooltip');

    const { style } = usePosition(context.triggerRef, context.contentRef, {
      side: props.side,
      align: props.align,
      sideOffset: props.sideOffset,
      alignOffset: props.alignOffset
    });

    return () => {
      if (!context.open.value) return null;

      return h(Teleport, { to: 'body' }, [
        h('div', {
          ref: context.contentRef,
          role: 'tooltip',
          'data-state': 'delayed-open',
          style: {
            ...style.value,
            zIndex: 60,
            pointerEvents: 'none',
            backgroundColor: 'black',
            color: 'white',
            borderRadius: '4px',
            padding: '5px 10px',
            fontSize: '12px'
          }
        }, slots.default?.())
      ]);
    };
  }
});
