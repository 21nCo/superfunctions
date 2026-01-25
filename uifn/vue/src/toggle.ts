import { defineComponent, h, PropType, toRefs } from 'vue';
import { useControllableState } from './hooks/use-controllable-state';

export const Toggle = defineComponent({
  name: 'Toggle',
  props: {
    pressed: {
      type: Boolean as PropType<boolean>,
      default: undefined
    },
    defaultPressed: {
      type: Boolean,
      default: false
    },
    disabled: {
      type: Boolean,
      default: false
    }
  },
  emits: ['update:pressed', 'change'],
  setup(props, { slots, emit }) {
    const { pressed, defaultPressed } = toRefs(props);
    
    const pressedState = useControllableState({
      prop: pressed,
      defaultProp: defaultPressed.value,
      emit,
      name: 'pressed'
    });

    const handleClick = (_e: MouseEvent) => {
      if (props.disabled) return;
      pressedState.value = !pressedState.value;
      emit('change', pressedState.value);
    };

    return () => {
      return h('button', {
        type: 'button',
        'aria-pressed': pressedState.value,
        'data-state': pressedState.value ? 'on' : 'off',
        'data-disabled': props.disabled ? '' : undefined,
        disabled: props.disabled,
        onClick: handleClick
      }, slots.default?.());
    };
  }
});
