import { defineComponent, h, PropType, toRefs, provide, inject, ref, Teleport, Ref } from 'vue';
import { useControllableState } from './hooks/use-controllable-state';
import { usePosition, Side, Align } from './hooks/use-position';
import { useOutsideClick } from './hooks/use-outside-click';
import { useEscapeKeydown } from './hooks/use-escape-keydown';

/* -------------------------------------------------------------------------------------------------
 * Popover Root
 * -----------------------------------------------------------------------------------------------*/

const PopoverSymbol = Symbol('Popover');

interface PopoverContext {
  open: Ref<boolean>;
  onOpenChange: (val: boolean) => void;
  triggerRef: Ref<HTMLElement | undefined>;
  contentRef: Ref<HTMLElement | undefined>;
  modal: boolean;
}

export const Popover = defineComponent({
  name: 'Popover',
  props: {
    open: {
      type: Boolean,
      default: undefined
    },
    defaultOpen: {
      type: Boolean,
      default: false
    },
    modal: {
      type: Boolean,
      default: false
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

    const triggerRef = ref<HTMLElement>();
    const contentRef = ref<HTMLElement>();

    provide(PopoverSymbol, {
      open,
      onOpenChange: (val: boolean) => { open.value = val; },
      triggerRef,
      contentRef,
      modal: modal.value
    });

    return () => slots.default?.();
  }
});

/* -------------------------------------------------------------------------------------------------
 * Popover Trigger
 * -----------------------------------------------------------------------------------------------*/

export const PopoverTrigger = defineComponent({
  name: 'PopoverTrigger',
  setup(_, { slots }) {
    const context = inject<PopoverContext>(PopoverSymbol);
    if (!context) throw new Error('PopoverTrigger must be used within Popover');

    const handleClick = () => {
      context.onOpenChange(!context.open.value);
    };

    return () => h('button', {
      type: 'button',
      ref: context.triggerRef,
      'aria-haspopup': 'dialog',
      'aria-expanded': context.open.value,
      'data-state': context.open.value ? 'open' : 'closed',
      onClick: handleClick
    }, slots.default?.());
  }
});

/* -------------------------------------------------------------------------------------------------
 * Popover Content
 * -----------------------------------------------------------------------------------------------*/

export const PopoverContent = defineComponent({
  name: 'PopoverContent',
  props: {
    side: {
      type: String as PropType<Side>,
      default: 'bottom'
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
    const context = inject<PopoverContext>(PopoverSymbol);
    if (!context) throw new Error('PopoverContent must be used within Popover');

    const { style } = usePosition(context.triggerRef, context.contentRef, {
      side: props.side,
      align: props.align,
      sideOffset: props.sideOffset,
      alignOffset: props.alignOffset
    });

    useOutsideClick(context.contentRef, (e) => {
      if (context.triggerRef.value?.contains(e.target as Node)) return;
      context.onOpenChange(false);
    }, context.open);

    useEscapeKeydown(() => {
      if (context.open.value) {
        context.onOpenChange(false);
        context.triggerRef.value?.focus();
      }
    });

    return () => {
      if (!context.open.value) return null;

      return h(Teleport, { to: 'body' }, [
        h('div', {
          ref: context.contentRef,
          'data-state': 'open',
          'data-side': props.side,
          'data-align': props.align,
          style: {
            ...style.value,
            zIndex: 50,
            backgroundColor: 'white',
            border: '1px solid #ccc',
            borderRadius: '4px',
            padding: '10px'
          }
        }, slots.default?.())
      ]);
    };
  }
});
