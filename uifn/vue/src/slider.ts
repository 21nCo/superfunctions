import { defineComponent, h, toRefs, ref, provide, inject, PropType, computed } from 'vue';
import { useControllableState } from './hooks/use-controllable-state';

/* -------------------------------------------------------------------------------------------------
 * Slider Root
 * -----------------------------------------------------------------------------------------------*/

const SliderSymbol = Symbol('Slider');

export const Slider = defineComponent({
  name: 'Slider',
  props: {
    name: String,
    disabled: { type: Boolean, default: false },
    orientation: { type: String as PropType<'horizontal' | 'vertical'>, default: 'horizontal' },
    dir: { type: String as PropType<'ltr' | 'rtl'>, default: 'ltr' },
    min: { type: Number, default: 0 },
    max: { type: Number, default: 100 },
    step: { type: Number, default: 1 },
    minStepsBetweenThumbs: { type: Number, default: 0 },
    value: { type: Array as PropType<number[]>, default: undefined },
    defaultValue: { type: Array as PropType<number[]>, default: [0] }
  },
  emits: ['update:value', 'valueChange'],
  setup(props, { slots, emit }) {
    const { value: valueProp, defaultValue, min, max, disabled, orientation } = toRefs(props);
    const value = useControllableState({
      prop: valueProp,
      defaultProp: defaultValue.value,
      emit,
      name: 'value'
    });

    const thumbs = ref<HTMLElement[]>([]);

    provide(SliderSymbol, {
      value,
      min,
      max,
      disabled,
      orientation,
      registerThumb: (el: HTMLElement) => {
          thumbs.value.push(el);
      }
    });

    return () => h('span', {
      dir: props.dir,
      'aria-disabled': disabled.value,
      'data-disabled': disabled.value ? '' : undefined,
      'data-orientation': orientation.value,
      style: {
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          userSelect: 'none',
          touchAction: 'none',
          width: orientation.value === 'horizontal' ? '200px' : '20px',
          height: orientation.value === 'horizontal' ? '20px' : '200px'
      }
    }, slots.default?.());
  }
});

/* -------------------------------------------------------------------------------------------------
 * Slider Track
 * -----------------------------------------------------------------------------------------------*/

export const SliderTrack = defineComponent({
  name: 'SliderTrack',
  setup(_, { slots }) {
    return () => h('span', {
        style: {
            position: 'relative',
            flexGrow: 1,
            borderRadius: '9999px',
            backgroundColor: '#ddd',
            height: '3px'
        }
    }, slots.default?.());
  }
});

/* -------------------------------------------------------------------------------------------------
 * Slider Range
 * -----------------------------------------------------------------------------------------------*/

export const SliderRange = defineComponent({
  name: 'SliderRange',
  setup() {
    const context = inject<any>(SliderSymbol);
    // Simplified range calc assuming single thumb or [start, end]
    const style = computed(() => {
        const val = context.value.value;
        const percent = ((val[0] - context.min.value) / (context.max.value - context.min.value)) * 100;
        return {
            position: 'absolute',
            backgroundColor: 'black',
            borderRadius: '9999px',
            height: '100%',
            width: `${percent}%`
        };
    });

    return () => h('span', { style: style.value });
  }
});

/* -------------------------------------------------------------------------------------------------
 * Slider Thumb
 * -----------------------------------------------------------------------------------------------*/

export const SliderThumb = defineComponent({
  name: 'SliderThumb',
  setup() {
    const context = inject<any>(SliderSymbol);
    const thumbRef = ref<HTMLElement>();
    
    // Position calc simplified
    const style = computed(() => {
        const val = context.value.value;
        const percent = ((val[0] - context.min.value) / (context.max.value - context.min.value)) * 100;
        return {
            position: 'absolute',
            left: `${percent}%`,
            width: '20px',
            height: '20px',
            borderRadius: '100%',
            backgroundColor: 'white',
            border: '1px solid #ccc',
            transform: 'translateX(-50%)',
            top: '-9px'
        };
    });

    return () => h('span', {
        ref: thumbRef,
        role: 'slider',
        'aria-valuemin': context.min.value,
        'aria-valuemax': context.max.value,
        'aria-valuenow': context.value.value[0],
        tabindex: context.disabled.value ? undefined : 0,
        style: style.value
    });
  }
});
