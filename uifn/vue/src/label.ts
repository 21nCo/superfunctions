import { defineComponent, h } from 'vue';

export const Label = defineComponent({
  name: 'Label',
  props: {
      htmlFor: String
  },
  setup(props, { slots, attrs }) {
    return () => h('label', {
      for: props.htmlFor,
      style: {
          fontSize: '14px',
          fontWeight: '500',
          lineHeight: '1',
          userSelect: 'none'
      },
      onMousedown: (e: MouseEvent) => {
          // prevent text selection when double clicking label
          if (!e.defaultPrevented && e.detail > 1) e.preventDefault();
      },
      ...attrs
    }, slots.default?.());
  }
});
