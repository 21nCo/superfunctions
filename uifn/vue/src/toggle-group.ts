import { defineComponent, h, toRefs, provide, inject, PropType, computed } from 'vue';
import { useControllableState } from './hooks/use-controllable-state';

/* -------------------------------------------------------------------------------------------------
 * ToggleGroup Root
 * -----------------------------------------------------------------------------------------------*/

const ToggleGroupSymbol = Symbol('ToggleGroup');

export const ToggleGroup = defineComponent({
  name: 'ToggleGroup',
  props: {
    type: { type: String as PropType<'single' | 'multiple'>, default: 'single' },
    value: { type: [String, Array] as PropType<string | string[]>, default: undefined },
    defaultValue: { type: [String, Array] as PropType<string | string[]>, default: undefined },
    disabled: { type: Boolean, default: false }
  },
  emits: ['update:value', 'valueChange'],
  setup(props, { slots, emit }) {
    const { value: valueProp, defaultValue, type, disabled } = toRefs(props);
    
    const value = useControllableState({
      prop: valueProp,
      defaultProp: defaultValue.value,
      emit,
      name: 'value'
    });

    const toggle = (itemValue: string) => {
        if (disabled.value) return;
        if (type.value === 'single') {
            value.value = value.value === itemValue ? undefined : itemValue; // Allow toggle off? usually yes for toggle group
        } else {
            const current = Array.isArray(value.value) ? value.value : [];
            if (current.includes(itemValue)) {
                value.value = current.filter(v => v !== itemValue);
            } else {
                value.value = [...current, itemValue];
            }
        }
    };

    provide(ToggleGroupSymbol, {
        value,
        type,
        disabled,
        toggle
    });

    return () => h('div', {
        role: 'group',
        dir: 'ltr',
        style: { display: 'inline-flex', gap: '1px' }
    }, slots.default?.());
  }
});

/* -------------------------------------------------------------------------------------------------
 * ToggleGroup Item
 * -----------------------------------------------------------------------------------------------*/

export const ToggleGroupItem = defineComponent({
  name: 'ToggleGroupItem',
  props: {
      value: { type: String, required: true },
      disabled: { type: Boolean, default: false }
  },
  setup(props, { slots }) {
      const context = inject<any>(ToggleGroupSymbol);
      
      const pressed = computed(() => {
          if (context.type.value === 'single') {
              return context.value.value === props.value;
          } else {
              return Array.isArray(context.value.value) && context.value.value.includes(props.value);
          }
      });

      const isDisabled = computed(() => context.disabled.value || props.disabled);

      return () => h('button', {
          type: 'button',
          role: 'radio', // or checkbox depending on type
          'aria-checked': pressed.value,
          'aria-pressed': pressed.value, // redundant but safe
          'data-state': pressed.value ? 'on' : 'off',
          'data-disabled': isDisabled.value ? '' : undefined,
          disabled: isDisabled.value,
          onClick: () => context.toggle(props.value),
          style: {
              backgroundColor: pressed.value ? '#ddd' : 'transparent',
              border: '1px solid #ccc',
              padding: '5px 10px',
              cursor: isDisabled.value ? 'not-allowed' : 'pointer'
          }
      }, slots.default?.());
  }
});
