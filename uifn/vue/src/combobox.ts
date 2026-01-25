import { defineComponent, h, PropType, toRefs, provide, inject, ref, computed, Teleport, Ref } from 'vue';
import { useControllableState } from './hooks/use-controllable-state';
import { usePosition, Side, Align } from './hooks/use-position';
import { useOutsideClick } from './hooks/use-outside-click';

/* -------------------------------------------------------------------------------------------------
 * Combobox Root
 * -----------------------------------------------------------------------------------------------*/

const ComboboxSymbol = Symbol('Combobox');

interface ComboboxContext {
  value: Ref<string>;
  inputValue: Ref<string>;
  open: Ref<boolean>;
  disabled: Ref<boolean>;
  onValueChange: (val: string) => void;
  onInputValueChange: (val: string) => void;
  onOpenChange: (val: boolean) => void;
  triggerRef: Ref<HTMLElement | undefined>;
  inputRef: Ref<HTMLInputElement | undefined>;
  contentRef: Ref<HTMLElement | undefined>;
}

export const Combobox = defineComponent({
  name: 'Combobox',
  props: {
    value: { type: String, default: undefined },
    defaultValue: { type: String, default: '' },
    inputValue: { type: String, default: undefined },
    defaultInputValue: { type: String, default: '' },
    open: { type: Boolean, default: undefined },
    defaultOpen: { type: Boolean, default: false },
    disabled: { type: Boolean, default: false },
    name: String
  },
  emits: ['update:value', 'valueChange', 'update:inputValue', 'inputValueChange', 'update:open', 'openChange'],
  setup(props, { slots, emit }) {
    const { value: valueProp, defaultValue, inputValue: inputValueProp, defaultInputValue, open: openProp, defaultOpen, disabled } = toRefs(props);

    const value = useControllableState({
      prop: valueProp,
      defaultProp: defaultValue.value,
      emit,
      name: 'value'
    });

    const inputValue = useControllableState({
      prop: inputValueProp,
      defaultProp: defaultInputValue.value,
      emit,
      name: 'inputValue'
    });

    const open = useControllableState({
      prop: openProp,
      defaultProp: defaultOpen.value,
      emit,
      name: 'open'
    });

    const triggerRef = ref<HTMLElement>();
    const inputRef = ref<HTMLInputElement>();
    const contentRef = ref<HTMLElement>();

    provide(ComboboxSymbol, {
      value,
      inputValue,
      open,
      disabled,
      triggerRef,
      inputRef,
      contentRef,
      onValueChange: (val: string) => { 
          value.value = val;
          // Usually we set input value to selected value too
          inputValue.value = val;
          open.value = false;
      },
      onInputValueChange: (val: string) => {
          if (disabled.value) return;
          inputValue.value = val;
          if (!open.value) open.value = true;
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
 * Combobox Input
 * -----------------------------------------------------------------------------------------------*/

export const ComboboxInput = defineComponent({
  name: 'ComboboxInput',
  setup(_, { slots, attrs }) {
    const context = inject<ComboboxContext>(ComboboxSymbol);
    if (!context) throw new Error('ComboboxInput must be used within Combobox');

    return () => h('input', {
      type: 'text',
      role: 'combobox',
      ref: context.inputRef,
      'aria-expanded': context.open.value,
      'aria-autocomplete': 'list',
      'aria-controls': 'combobox-content',
      'aria-disabled': context.disabled.value,
      disabled: context.disabled.value,
      value: context.inputValue.value,
      onInput: (e: Event) => context.onInputValueChange((e.target as HTMLInputElement).value),
      onKeydown: (e: KeyboardEvent) => {
          if (e.key === 'ArrowDown') {
              e.preventDefault();
              context.onOpenChange(true);
          } else if (e.key === 'Escape') {
              e.preventDefault();
              context.onOpenChange(false);
          }
      },
      ...attrs
    }, slots.default?.());
  }
});

/* -------------------------------------------------------------------------------------------------
 * Combobox Trigger
 * -----------------------------------------------------------------------------------------------*/

export const ComboboxTrigger = defineComponent({
  name: 'ComboboxTrigger',
  setup(_, { slots }) {
    const context = inject<ComboboxContext>(ComboboxSymbol);
    if (!context) throw new Error('ComboboxTrigger must be used within Combobox');

    return () => h('button', {
      type: 'button',
      ref: context.triggerRef,
      'aria-haspopup': 'listbox',
      'aria-expanded': context.open.value,
      'data-state': context.open.value ? 'open' : 'closed',
      disabled: context.disabled.value,
      onClick: (e: MouseEvent) => {
          e.preventDefault();
          context.onOpenChange(!context.open.value);
          if (!context.open.value) {
              context.inputRef.value?.focus();
          }
      },
      tabindex: -1
    }, slots.default?.());
  }
});

/* -------------------------------------------------------------------------------------------------
 * Combobox Content
 * -----------------------------------------------------------------------------------------------*/

export const ComboboxContent = defineComponent({
  name: 'ComboboxContent',
  props: {
    side: { type: String as PropType<Side>, default: 'bottom' },
    align: { type: String as PropType<Align>, default: 'start' },
    sideOffset: { type: Number, default: 0 },
    alignOffset: { type: Number, default: 0 }
  },
  setup(props, { slots }) {
    const context = inject<ComboboxContext>(ComboboxSymbol);
    if (!context) throw new Error('ComboboxContent must be used within Combobox');

    const anchorRef = computed(() => context.inputRef.value || context.triggerRef.value);

    const { style } = usePosition(anchorRef, context.contentRef, {
        side: props.side,
        align: props.align,
        sideOffset: props.sideOffset,
        alignOffset: props.alignOffset
    });

    useOutsideClick(context.contentRef, () => {
        context.onOpenChange(false);
    }, context.open);

    return () => {
        if (!context.open.value) return null;

        return h(Teleport, { to: 'body' }, [
            h('div', {
                ref: context.contentRef,
                role: 'listbox',
                id: 'combobox-content',
                'data-state': context.open.value ? 'open' : 'closed',
                style: {
                    ...style.value,
                    zIndex: 50,
                    minWidth: '100px',
                    backgroundColor: 'white',
                    border: '1px solid #ccc',
                    borderRadius: '4px',
                    boxShadow: '0 2px 10px rgba(0,0,0,0.1)',
                    maxHeight: '300px',
                    overflowY: 'auto'
                }
            }, slots.default?.())
        ]);
    };
  }
});

/* -------------------------------------------------------------------------------------------------
 * Combobox Item
 * -----------------------------------------------------------------------------------------------*/

const ComboboxItemSymbol = Symbol('ComboboxItem');

export const ComboboxItem = defineComponent({
  name: 'ComboboxItem',
  props: {
      value: { type: String, required: true },
      disabled: { type: Boolean, default: false }
  },
  setup(props, { slots }) {
      const context = inject<ComboboxContext>(ComboboxSymbol);
      const isSelected = computed(() => context?.value.value === props.value);

      provide(ComboboxItemSymbol, { isSelected });

      return () => h('div', {
          role: 'option',
          'aria-selected': isSelected.value,
          'data-state': isSelected.value ? 'checked' : 'unchecked',
          'aria-disabled': props.disabled,
          'data-disabled': props.disabled ? '' : undefined,
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
 * Combobox Helpers
 * -----------------------------------------------------------------------------------------------*/

export const ComboboxItemIndicator = defineComponent({
  name: 'ComboboxItemIndicator',
  setup(_, { slots }) {
      const itemContext = inject<{ isSelected: Ref<boolean> }>(ComboboxItemSymbol);
      if (!itemContext?.isSelected.value) return () => null;
      return () => h('span', { 'aria-hidden': true }, slots.default?.() || '✓');
  }
});

export const ComboboxGroup = defineComponent({
    name: 'ComboboxGroup',
    setup(_, { slots }) {
        return () => h('div', { role: 'group' }, slots.default?.());
    }
});

export const ComboboxLabel = defineComponent({
    name: 'ComboboxLabel',
    setup(_, { slots }) {
        return () => h('div', { 
            style: { padding: '5px 10px', fontSize: '12px', color: '#666' } 
        }, slots.default?.());
    }
});

export const ComboboxSeparator = defineComponent({
    name: 'ComboboxSeparator',
    setup() {
        return () => h('div', { 
            style: { height: '1px', backgroundColor: '#eee', margin: '5px 0' } 
        });
    }
});
