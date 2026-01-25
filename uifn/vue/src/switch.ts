import { defineComponent, h, PropType, toRefs, provide, inject } from 'vue';
import { useControllableState } from './hooks/use-controllable-state';

const SwitchSymbol = Symbol('Switch');

interface SwitchContext {
  checked: boolean;
  disabled: boolean;
}

export const Switch = defineComponent({
  name: 'Switch',
  props: {
    checked: {
      type: Boolean as PropType<boolean>,
      default: undefined
    },
    defaultChecked: {
      type: Boolean,
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
      checked.value = !checked.value;
    };

    provide(SwitchSymbol, {
      get checked() { return checked.value; },
      get disabled() { return disabled.value; }
    });

    return () => [
      h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': checked.value,
        'aria-required': props.required,
        'aria-disabled': disabled.value,
        'data-state': checked.value ? 'checked' : 'unchecked',
        'data-disabled': disabled.value ? '' : undefined,
        disabled: disabled.value,
        value: props.value,
        onClick: handleClick
      }, slots.default?.()),
      (checked.value && !disabled.value) ? h('input', {
        type: 'checkbox',
        'aria-hidden': true,
        checked: true,
        name: props.name,
        value: props.value,
        style: { transform: 'translateX(-100%)', position: 'absolute', pointerEvents: 'none', opacity: 0, margin: 0 },
        tabindex: -1
      }) : null
    ];
  }
});

export const SwitchThumb = defineComponent({
  name: 'SwitchThumb',
  setup(_, { slots }) {
    const context = inject<SwitchContext>(SwitchSymbol);
    if (!context) throw new Error('SwitchThumb must be used within Switch');

    return () => h('span', {
      'data-state': context.checked ? 'checked' : 'unchecked',
      'data-disabled': context.disabled ? '' : undefined
    }, slots.default?.());
  }
});
