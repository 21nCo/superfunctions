import { defineComponent, h, PropType, toRefs, provide, inject, ref, Teleport, Ref } from 'vue';
import { useControllableState } from './hooks/use-controllable-state';
import { usePosition, Side, Align } from './hooks/use-position';

/* -------------------------------------------------------------------------------------------------
 * HoverCard Root
 * -----------------------------------------------------------------------------------------------*/

const HoverCardSymbol = Symbol('HoverCard');

interface HoverCardContext {
  open: Ref<boolean>;
  triggerRef: Ref<HTMLElement | undefined>;
  contentRef: Ref<HTMLElement | undefined>;
  openDelay: number;
  closeDelay: number;
  onOpen: () => void;
  onClose: () => void;
}

export const HoverCard = defineComponent({
  name: 'HoverCard',
  props: {
    open: { type: Boolean, default: undefined },
    defaultOpen: { type: Boolean, default: false },
    openDelay: { type: Number, default: 700 },
    closeDelay: { type: Number, default: 300 }
  },
  emits: ['update:open', 'openChange'],
  setup(props, { slots, emit }) {
    const { open: openProp, defaultOpen, openDelay, closeDelay } = toRefs(props);

    const open = useControllableState({
      prop: openProp,
      defaultProp: defaultOpen.value,
      emit,
      name: 'open'
    });

    const triggerRef = ref<HTMLElement>();
    const contentRef = ref<HTMLElement>();
    let openTimer: any;
    let closeTimer: any;

    const handleOpen = () => {
        clearTimeout(closeTimer);
        openTimer = setTimeout(() => {
            open.value = true;
        }, openDelay.value);
    };

    const handleClose = () => {
        clearTimeout(openTimer);
        closeTimer = setTimeout(() => {
            open.value = false;
        }, closeDelay.value);
    };

    provide(HoverCardSymbol, {
      open,
      triggerRef,
      contentRef,
      openDelay: openDelay.value,
      closeDelay: closeDelay.value,
      onOpen: handleOpen,
      onClose: handleClose
    });

    return () => slots.default?.();
  }
});

/* -------------------------------------------------------------------------------------------------
 * HoverCard Trigger
 * -----------------------------------------------------------------------------------------------*/

export const HoverCardTrigger = defineComponent({
  name: 'HoverCardTrigger',
  setup(_, { slots, attrs }) {
    const context = inject<HoverCardContext>(HoverCardSymbol);
    if (!context) throw new Error('HoverCardTrigger must be used within HoverCard');

    return () => h('a', {
      ref: context.triggerRef,
      'data-state': context.open.value ? 'open' : 'closed',
      onMouseenter: context.onOpen,
      onMouseleave: context.onClose,
      onFocus: context.onOpen,
      onBlur: context.onClose,
      href: '#',
      ...attrs
    }, slots.default?.());
  }
});

/* -------------------------------------------------------------------------------------------------
 * HoverCard Content
 * -----------------------------------------------------------------------------------------------*/

export const HoverCardContent = defineComponent({
  name: 'HoverCardContent',
  props: {
    side: { type: String as PropType<Side>, default: 'bottom' },
    align: { type: String as PropType<Align>, default: 'center' },
    sideOffset: { type: Number, default: 5 },
    alignOffset: { type: Number, default: 0 }
  },
  setup(props, { slots, attrs }) {
    const context = inject<HoverCardContext>(HoverCardSymbol);
    if (!context) throw new Error('HoverCardContent must be used within HoverCard');

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
                'data-state': context.open.value ? 'open' : 'closed',
                'data-side': props.side,
                'data-align': props.align,
                onMouseenter: () => {
                    // Cancel close if moving from trigger to content
                    // Ideally we expose cancelClose but re-triggering open works if logic allows
                    context.onOpen(); 
                },
                onMouseleave: context.onClose,
                style: {
                    ...style.value,
                    zIndex: 50,
                    backgroundColor: 'white',
                    border: '1px solid #ccc',
                    borderRadius: '4px',
                    padding: '10px',
                    boxShadow: '0 2px 10px rgba(0,0,0,0.1)',
                    ...attrs.style as any
                },
                ...attrs
            }, slots.default?.())
        ]);
    };
  }
});
