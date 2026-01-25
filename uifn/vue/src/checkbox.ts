import { defineComponent, h, PropType, toRefs, provide, inject } from 'vue';
import { useControllableState } from './hooks/use-controllable-state';
import { CheckedState } from '@uifn/core/primitives/checkbox';

const CheckboxSymbol = Symbol('Checkbox');

interface CheckboxContext {
  checked: CheckedState;
  disabled: boolean;
}

export const Checkbox = defineComponent({
  name: 'Checkbox',
  props: {
    checked: {
      type: [Boolean, String] as PropType<CheckedState>,
      default: undefined
    },
    defaultChecked: {
      type: [Boolean, String] as PropType<CheckedState>,
      default: false
    },
    required: Boolean,
    disabled: Boolean,
    name: String,
    value: {
      type: String,
      default: 'on'
    }
  },
  emits: ['update:checked', 'checkedChange'],
  setup(props, { slots, emit }) {
    const { checked: checkedProp, defaultChecked, disabled } = toRefs(props);

    const checked = useControllableState({
      prop: checkedProp,
      defaultProp: defaultChecked.value,
      emit,
      name: 'checked'
    });

    const handleClick = (_e: MouseEvent) => {
      if (disabled.value) return;
      checked.value = checked.value === 'indeterminate' ? true : !checked.value;
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
      }
    };

    provide(CheckboxSymbol, {
      get checked() { return checked.value; },
      get disabled() { return disabled.value; }
    });

    return () => [
      h('button', {
        type: 'button',
        role: 'checkbox',
        'aria-checked': checked.value === 'indeterminate' ? 'mixed' : checked.value,
        'aria-required': props.required,
        'aria-disabled': disabled.value,
        'data-state': checked.value === 'indeterminate' ? 'indeterminate' : (checked.value ? 'checked' : 'unchecked'),
        'data-disabled': disabled.value ? '' : undefined,
        disabled: disabled.value,
        value: props.value,
        onClick: handleClick,
        onKeydown: handleKeyDown
      }, slots.default?.()),
      (checked.value && !disabled.value) ? h('input', {
        type: 'checkbox',
        'aria-hidden': true,
        checked: true, // simplified
        name: props.name,
        value: props.value,
        style: { transform: 'translateX(-100%)', position: 'absolute', pointerEvents: 'none', opacity: 0, margin: 0 },
        tabindex: -1
      }) : null
    ];
  }
});

export const CheckboxIndicator = defineComponent({
  name: 'CheckboxIndicator',
  props: {
    forceMount: Boolean
  },
  setup(props, { slots }) {
    const context = inject<CheckboxContext>(CheckboxSymbol);
    if (!context) throw new Error('CheckboxIndicator must be used within Checkbox');

    return () => {
      if (!props.forceMount && !context.checked) return null;
      
      return h('span', {
        'data-state': context.checked === 'indeterminate' ? 'indeterminate' : (context.checked ? 'checked' : 'unchecked'),
        'data-disabled': context.disabled ? '' : undefined,
        style: { pointerEvents: 'none' }
      }, slots.default?.());
    };
  }
});
