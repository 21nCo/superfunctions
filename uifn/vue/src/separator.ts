import { defineComponent, h, PropType } from 'vue';

export const Separator = defineComponent({
  name: 'Separator',
  props: {
    orientation: {
      type: String as PropType<'horizontal' | 'vertical'>,
      default: 'horizontal'
    },
    decorative: {
      type: Boolean,
      default: false
    }
  },
  setup(props, { attrs }) {
    return () => h('div', {
      role: props.decorative ? 'none' : 'separator',
      'aria-orientation': props.decorative ? undefined : props.orientation,
      'data-orientation': props.orientation,
      style: {
          backgroundColor: '#eee',
          height: props.orientation === 'horizontal' ? '1px' : '100%',
          width: props.orientation === 'horizontal' ? '100%' : '1px'
      },
      ...attrs
    });
  }
});
