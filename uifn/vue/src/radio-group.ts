import { defineComponent, h, PropType, toRefs, provide, inject, computed } from 'vue';
import { useControllableState } from './hooks/use-controllable-state';

/* -------------------------------------------------------------------------------------------------
 * RadioGroup Root
 * -----------------------------------------------------------------------------------------------*/

const RadioGroupSymbol = Symbol('RadioGroup');

interface RadioGroupContext {
  value: string;
  onValueChange: (val: string) => void;
  disabled: boolean;
  required: boolean;
  name?: string;
}

export const RadioGroup = defineComponent({
  name: 'RadioGroup',
  props: {
    value: {
      type: String,
      default: undefined
    },
    defaultValue: {
      type: String,
      default: ''
    },
    disabled: Boolean,
    required: Boolean,
    name: String,
    orientation: {
      type: String as PropType<'horizontal' | 'vertical'>,
      default: 'vertical'
    }
  },
  emits: ['update:value', 'valueChange'],
  setup(props, { slots, emit }) {
    const { value: valueProp, defaultValue, disabled, required, name } = toRefs(props);

    const value = useControllableState({
      prop: valueProp,
      defaultProp: defaultValue.value,
      emit,
      name: 'value'
    });

    provide(RadioGroupSymbol, {
      get value() { return value.value; },
      onValueChange: (val: string) => {
        value.value = val;
      },
      get disabled() { return disabled.value; },
      get required() { return required.value; },
      get name() { return name?.value; }
    });

    return () => h('div', {
      role: 'radiogroup',
      'aria-required': required.value,
      'aria-orientation': props.orientation,
      'data-disabled': disabled.value ? '' : undefined
    }, slots.default?.());
  }
});

/* -------------------------------------------------------------------------------------------------
 * RadioGroup Item
 * -----------------------------------------------------------------------------------------------*/

const RadioGroupItemSymbol = Symbol('RadioGroupItem');

interface RadioGroupItemContext {
  checked: boolean;
  disabled: boolean;
}

export const RadioGroupItem = defineComponent({
  name: 'RadioGroupItem',
  props: {
    value: {
      type: String,
      required: true
    },
    disabled: Boolean
  },
  setup(props, { slots }) {
    const context = inject<RadioGroupContext>(RadioGroupSymbol);
    if (!context) throw new Error('RadioGroupItem must be used within RadioGroup');

    const checked = computed(() => context.value === props.value);
    const disabled = computed(() => context.disabled || props.disabled);

    const handleClick = () => {
      if (disabled.value) return;
      context.onValueChange(props.value);
    };

    provide(RadioGroupItemSymbol, {
      get checked() { return checked.value; },
      get disabled() { return disabled.value; }
    });

    return () => [
      h('button', {
        type: 'button',
        role: 'radio',
        'aria-checked': checked.value,
        'data-state': checked.value ? 'checked' : 'unchecked',
        'data-disabled': disabled.value ? '' : undefined,
        disabled: disabled.value,
        value: props.value,
        tabindex: checked.value ? 0 : -1,
        onClick: handleClick
      }, slots.default?.()),
      (checked.value && !disabled.value) ? h('input', {
        type: 'radio',
        'aria-hidden': true,
        checked: true,
        name: context.name,
        value: props.value,
        style: { transform: 'translateX(-100%)', position: 'absolute', pointerEvents: 'none', opacity: 0, margin: 0 },
        tabindex: -1
      }) : null
    ];
  }
});

/* -------------------------------------------------------------------------------------------------
 * RadioGroup Indicator
 * -----------------------------------------------------------------------------------------------*/

export const RadioGroupIndicator = defineComponent({
  name: 'RadioGroupIndicator',
  props: {
    forceMount: Boolean
  },
  setup(props, { slots }) {
    const itemContext = inject<RadioGroupItemContext>(RadioGroupItemSymbol);
    if (!itemContext) throw new Error('RadioGroupIndicator must be used within RadioGroupItem');

    return () => {
      if (!props.forceMount && !itemContext.checked) return null;
      
      return h('span', {
        'data-state': itemContext.checked ? 'checked' : 'unchecked',
        'data-disabled': itemContext.disabled ? '' : undefined
      }, slots.default?.());
    };
  }
});
