import { defineComponent, h, PropType } from 'vue';

/* -------------------------------------------------------------------------------------------------
 * Toolbar Root
 * -----------------------------------------------------------------------------------------------*/

export const Toolbar = defineComponent({
  name: 'Toolbar',
  props: {
    orientation: { type: String as PropType<'horizontal' | 'vertical'>, default: 'horizontal' },
    loop: { type: Boolean, default: true }
  },
  setup(props, { slots }) {
    return () => h('div', {
      role: 'toolbar',
      'aria-orientation': props.orientation,
      dir: 'ltr',
      style: {
          display: 'flex',
          padding: '10px',
          width: '100%',
          minWidth: 'max-content',
          gap: '10px',
          alignItems: 'center',
          flexDirection: props.orientation === 'horizontal' ? 'row' : 'column'
      }
    }, slots.default?.());
  }
});

export const ToolbarButton = defineComponent({
  name: 'ToolbarButton',
  setup(_, { slots, attrs }) {
    return () => h('button', {
        type: 'button',
        ...attrs,
        style: {
            padding: '5px 10px',
            ...attrs.style as any
        }
    }, slots.default?.());
  }
});

export const ToolbarSeparator = defineComponent({
  name: 'ToolbarSeparator',
  setup(_, { attrs }) {
    return () => h('div', {
        role: 'separator',
        ...attrs,
        style: {
            width: '1px',
            backgroundColor: '#ccc',
            margin: '0 5px',
            alignSelf: 'stretch',
            ...attrs.style as any
        }
    });
  }
});

export const ToolbarLink = defineComponent({
    name: 'ToolbarLink',
    setup(_, { slots, attrs }) {
        return () => h('a', {
            ...attrs,
            style: {
                textDecoration: 'none',
                color: 'inherit',
                ...attrs.style as any
            }
        }, slots.default?.());
    }
});
