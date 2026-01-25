import { defineComponent, h } from 'vue';

export const Badge = defineComponent({
  name: 'Badge',
  setup(_, { slots, attrs }) {
    return () => h('span', {
      style: {
          display: 'inline-flex',
          alignItems: 'center',
          borderRadius: '9999px',
          border: '1px solid transparent',
          padding: '2px 10px',
          fontSize: '12px',
          fontWeight: '600',
          transition: 'colors 0.2s ease-in-out',
          backgroundColor: '#333',
          color: 'white'
      },
      ...attrs
    }, slots.default?.());
  }
});
