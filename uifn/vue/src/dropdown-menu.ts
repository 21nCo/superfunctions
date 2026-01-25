import { defineComponent, h, PropType, toRefs, provide, inject, ref, Teleport, Ref } from 'vue';
import { useControllableState } from './hooks/use-controllable-state';
import { usePosition, Side, Align } from './hooks/use-position';
import { useOutsideClick } from './hooks/use-outside-click';
import { useEscapeKeydown } from './hooks/use-escape-keydown';

/* -------------------------------------------------------------------------------------------------
 * DropdownMenu Root
 * -----------------------------------------------------------------------------------------------*/

const DropdownMenuSymbol = Symbol('DropdownMenu');

interface DropdownMenuContext {
  open: Ref<boolean>;
  onOpenChange: (val: boolean) => void;
  triggerRef: Ref<HTMLElement | undefined>;
  contentRef: Ref<HTMLElement | undefined>;
}

export const DropdownMenu = defineComponent({
  name: 'DropdownMenu',
  props: {
    open: {
      type: Boolean,
      default: undefined
    },
    defaultOpen: {
      type: Boolean,
      default: false
    }
  },
  emits: ['update:open', 'openChange'],
  setup(props, { slots, emit }) {
    const { open: openProp, defaultOpen } = toRefs(props);

    const open = useControllableState({
      prop: openProp,
      defaultProp: defaultOpen.value,
      emit,
      name: 'open'
    });

    const triggerRef = ref<HTMLElement>();
    const contentRef = ref<HTMLElement>();

    provide(DropdownMenuSymbol, {
      open,
      onOpenChange: (val: boolean) => { open.value = val; },
      triggerRef,
      contentRef
    });

    return () => slots.default?.();
  }
});

/* -------------------------------------------------------------------------------------------------
 * DropdownMenu Trigger
 * -----------------------------------------------------------------------------------------------*/

export const DropdownMenuTrigger = defineComponent({
  name: 'DropdownMenuTrigger',
  setup(_, { slots }) {
    const context = inject<DropdownMenuContext>(DropdownMenuSymbol);
    if (!context) throw new Error('DropdownMenuTrigger must be used within DropdownMenu');

    const handleClick = () => {
      context.onOpenChange(!context.open.value);
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!context.open.value) context.onOpenChange(true);
      }
    };

    return () => h('button', {
      type: 'button',
      ref: context.triggerRef,
      'aria-haspopup': 'menu',
      'aria-expanded': context.open.value,
      'data-state': context.open.value ? 'open' : 'closed',
      onClick: handleClick,
      onKeydown: handleKeyDown
    }, slots.default?.());
  }
});

/* -------------------------------------------------------------------------------------------------
 * DropdownMenu Content
 * -----------------------------------------------------------------------------------------------*/

export const DropdownMenuContent = defineComponent({
  name: 'DropdownMenuContent',
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
    const context = inject<DropdownMenuContext>(DropdownMenuSymbol);
    if (!context) throw new Error('DropdownMenuContent must be used within DropdownMenu');

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

    const handleKeyDown = (_: KeyboardEvent) => {
      // Similar logic to React
    };

    return () => {
      if (!context.open.value) return null;

      return h(Teleport, { to: 'body' }, [
        h('div', {
          ref: context.contentRef,
          role: 'menu',
          'data-state': 'open',
          'data-side': props.side,
          'data-align': props.align,
          style: {
            ...style.value,
            zIndex: 50,
            backgroundColor: 'white',
            border: '1px solid #ccc',
            borderRadius: '4px',
            padding: '5px 0',
            minWidth: '150px'
          },
          onKeydown: handleKeyDown
        }, slots.default?.())
      ]);
    };
  }
});

/* -------------------------------------------------------------------------------------------------
 * DropdownMenu Item
 * -----------------------------------------------------------------------------------------------*/

export const DropdownMenuItem = defineComponent({
  name: 'DropdownMenuItem',
  props: {
    disabled: {
      type: Boolean,
      default: false
    }
  },
  emits: ['select'],
  setup(props, { slots, emit }) {
    const context = inject<DropdownMenuContext>(DropdownMenuSymbol);

    const handleSelect = (e: Event) => {
      if (props.disabled) return;
      emit('select', e);
      if (!e.defaultPrevented) {
        context?.onOpenChange(false);
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (props.disabled) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleSelect(e);
      }
    };

    return () => h('div', {
      role: 'menuitem',
      'aria-disabled': props.disabled,
      'data-disabled': props.disabled ? '' : undefined,
      tabindex: props.disabled ? -1 : 0,
      onClick: handleSelect,
      onKeydown: handleKeyDown,
      style: {
        padding: '5px 10px',
        cursor: props.disabled ? 'not-allowed' : 'pointer',
        opacity: props.disabled ? 0.5 : 1,
        outline: 'none'
      }
    }, slots.default?.());
  }
});

/* -------------------------------------------------------------------------------------------------
 * DropdownMenu Label
 * -----------------------------------------------------------------------------------------------*/

export const DropdownMenuLabel = defineComponent({
  name: 'DropdownMenuLabel',
  setup(_, { slots }) {
    return () => h('div', {
      style: {
        padding: '5px 10px',
        fontSize: '12px',
        color: '#666',
        fontWeight: 'bold'
      }
    }, slots.default?.());
  }
});

/* -------------------------------------------------------------------------------------------------
 * DropdownMenu Separator
 * -----------------------------------------------------------------------------------------------*/

export const DropdownMenuSeparator = defineComponent({
  name: 'DropdownMenuSeparator',
  setup() {
    return () => h('div', {
      role: 'separator',
      style: {
        height: '1px',
        backgroundColor: '#eee',
        margin: '5px 0'
      }
    });
  }
});
