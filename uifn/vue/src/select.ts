import { defineComponent, h, PropType, toRefs, provide, inject, ref, computed, Teleport, Ref } from 'vue';
import { useControllableState } from './hooks/use-controllable-state';
import { usePosition, Side, Align } from './hooks/use-position';
import { useOutsideClick } from './hooks/use-outside-click';
import { useFocusTrap } from './hooks/use-focus-trap';

/* -------------------------------------------------------------------------------------------------
 * Select Root
 * -----------------------------------------------------------------------------------------------*/

const SelectSymbol = Symbol('Select');

interface SelectContext {
  value: Ref<string>;
  open: Ref<boolean>;
  disabled: Ref<boolean>;
  onValueChange: (val: string) => void;
  onOpenChange: (val: boolean) => void;
  triggerRef: Ref<HTMLElement | undefined>;
  contentRef: Ref<HTMLElement | undefined>;
}

export const Select = defineComponent({
  name: 'Select',
  props: {
    value: { type: String, default: undefined },
    defaultValue: { type: String, default: '' },
    open: { type: Boolean, default: undefined },
    defaultOpen: { type: Boolean, default: false },
    disabled: { type: Boolean, default: false },
    required: { type: Boolean, default: false },
    name: String
  },
  emits: ['update:value', 'valueChange', 'update:open', 'openChange'],
  setup(props, { slots, emit }) {
    const { value: valueProp, defaultValue, open: openProp, defaultOpen, disabled } = toRefs(props);

    const value = useControllableState({
      prop: valueProp,
      defaultProp: defaultValue.value,
      emit,
      name: 'value'
    });

    const open = useControllableState({
      prop: openProp,
      defaultProp: defaultOpen.value,
      emit,
      name: 'open'
    });

    const triggerRef = ref<HTMLElement>();
    const contentRef = ref<HTMLElement>();

    provide(SelectSymbol, {
      value,
      open,
      disabled,
      triggerRef,
      contentRef,
      onValueChange: (val: string) => { 
          value.value = val;
          open.value = false;
      },
      onOpenChange: (val: boolean) => {
          if (disabled.value) return;
          open.value = val;
      }
    });

    return () => [
        slots.default?.(),
        props.name ? h('input', { type: 'hidden', name: props.name, value: value.value }) : null
    ];
  }
});

/* -------------------------------------------------------------------------------------------------
 * Select Trigger
 * -----------------------------------------------------------------------------------------------*/

export const SelectTrigger = defineComponent({
  name: 'SelectTrigger',
  setup(_, { slots }) {
    const context = inject<SelectContext>(SelectSymbol);
    if (!context) throw new Error('SelectTrigger must be used within Select');

    return () => h('button', {
      type: 'button',
      role: 'combobox',
      ref: context.triggerRef,
      'aria-expanded': context.open.value,
      'data-state': context.open.value ? 'open' : 'closed',
      'data-disabled': context.disabled.value ? '' : undefined,
      disabled: context.disabled.value,
      onClick: (e: MouseEvent) => {
          // prevent default submission
          e.preventDefault();
          context.onOpenChange(!context.open.value);
      }
    }, slots.default?.());
  }
});

/* -------------------------------------------------------------------------------------------------
 * Select Value
 * -----------------------------------------------------------------------------------------------*/

export const SelectValue = defineComponent({
  name: 'SelectValue',
  props: {
      placeholder: String
  },
  setup(props, { slots }) {
    const context = inject<SelectContext>(SelectSymbol);
    return () => h('span', { style: { pointerEvents: 'none' } }, [
        context?.value.value || props.placeholder || slots.default?.()
    ]);
  }
});

/* -------------------------------------------------------------------------------------------------
 * Select Content
 * -----------------------------------------------------------------------------------------------*/

export const SelectContent = defineComponent({
  name: 'SelectContent',
  props: {
    side: { type: String as PropType<Side>, default: 'bottom' },
    align: { type: String as PropType<Align>, default: 'start' },
    sideOffset: { type: Number, default: 0 },
    alignOffset: { type: Number, default: 0 }
  },
  setup(props, { slots }) {
    const context = inject<SelectContext>(SelectSymbol);
    if (!context) throw new Error('SelectContent must be used within Select');

    const { style } = usePosition(context.triggerRef, context.contentRef, {
        side: props.side,
        align: props.align,
        sideOffset: props.sideOffset,
        alignOffset: props.alignOffset
    });

    useOutsideClick(context.contentRef, () => {
        context.onOpenChange(false);
    }, context.open);

    // Focus trap inside content when open
    useFocusTrap(context.contentRef, context.open, { returnFocus: true });

    return () => {
        if (!context.open.value) return null;

        return h(Teleport, { to: 'body' }, [
            h('div', {
                ref: context.contentRef,
                role: 'listbox',
                'data-state': context.open.value ? 'open' : 'closed',
                style: {
                    ...style.value,
                    zIndex: 50,
                    minWidth: '100px',
                    backgroundColor: 'white',
                    border: '1px solid #ccc',
                    borderRadius: '4px',
                    boxShadow: '0 2px 10px rgba(0,0,0,0.1)'
                }
            }, slots.default?.())
        ]);
    };
  }
});

/* -------------------------------------------------------------------------------------------------
 * Select Viewport
 * -----------------------------------------------------------------------------------------------*/

export const SelectViewport = defineComponent({
  name: 'SelectViewport',
  setup(_, { slots }) {
    return () => h('div', {
        style: { padding: '5px', overflowY: 'auto', maxHeight: '300px' }
    }, slots.default?.());
  }
});

/* -------------------------------------------------------------------------------------------------
 * Select Item
 * -----------------------------------------------------------------------------------------------*/

const SelectItemSymbol = Symbol('SelectItem');

export const SelectItem = defineComponent({
  name: 'SelectItem',
  props: {
      value: { type: String, required: true },
      disabled: { type: Boolean, default: false }
  },
  setup(props, { slots }) {
      const context = inject<SelectContext>(SelectSymbol);
      const isSelected = computed(() => context?.value.value === props.value);

      provide(SelectItemSymbol, { isSelected });

      return () => h('div', {
          role: 'option',
          'aria-selected': isSelected.value,
          'data-state': isSelected.value ? 'checked' : 'unchecked',
          'data-disabled': props.disabled ? '' : undefined,
          'aria-disabled': props.disabled,
          style: {
              cursor: props.disabled ? 'not-allowed' : 'pointer',
              padding: '5px 10px',
              outline: 'none'
          },
          onClick: (e: MouseEvent) => {
              if (props.disabled) return;
              e.stopPropagation();
              context?.onValueChange(props.value);
          }
      }, slots.default?.());
  }
});

/* -------------------------------------------------------------------------------------------------
 * Select Item Indicator
 * -----------------------------------------------------------------------------------------------*/

export const SelectItemIndicator = defineComponent({
  name: 'SelectItemIndicator',
  setup(_, { slots }) {
      const itemContext = inject<{ isSelected: Ref<boolean> }>(SelectItemSymbol);
      if (!itemContext?.isSelected.value) return () => null;
      
      return () => h('span', { 'aria-hidden': true }, slots.default?.() || '✓');
  }
});

export const SelectGroup = defineComponent({
    name: 'SelectGroup',
    setup(_, { slots }) {
        return () => h('div', { role: 'group' }, slots.default?.());
    }
});

export const SelectLabel = defineComponent({
    name: 'SelectLabel',
    setup(_, { slots }) {
        return () => h('div', { 
            style: { padding: '5px 10px', fontSize: '12px', color: '#666' } 
        }, slots.default?.());
    }
});

export const SelectSeparator = defineComponent({
    name: 'SelectSeparator',
    setup() {
        return () => h('div', { 
            style: { height: '1px', backgroundColor: '#eee', margin: '5px 0' } 
        });
    }
});
