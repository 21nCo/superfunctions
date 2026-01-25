import { defineComponent, h, toRefs, computed } from 'vue';

export const Progress = defineComponent({
  name: 'Progress',
  props: {
    value: { type: Number, default: 0 },
    max: { type: Number, default: 100 }
  },
  setup(props, { slots }) {
    const { value, max } = toRefs(props);
    const percentage = computed(() => {
        if (max.value === 0) return 0;
        return Math.min(Math.max(value.value, 0), max.value) / max.value * 100;
    });

    return () => h('div', {
      role: 'progressbar',
      'aria-valuemax': max.value,
      'aria-valuemin': 0,
      'aria-valuenow': value.value,
      'data-state': value.value === null ? 'indeterminate' : (value.value === max.value ? 'complete' : 'loading'),
      style: {
          position: 'relative',
          overflow: 'hidden',
          background: '#eee',
          borderRadius: '999px',
          width: '100%',
          height: '10px'
      }
    }, [
        slots.default ? slots.default() : h('div', {
            'data-state': value.value === null ? 'indeterminate' : (value.value === max.value ? 'complete' : 'loading'),
            style: {
                backgroundColor: 'currentColor',
                width: '100%',
                height: '100%',
                transition: 'transform 660ms cubic-bezier(0.65, 0, 0.35, 1)',
                transform: `translateX(-${100 - percentage.value}%)`
            }
        })
    ]);
  }
});

// Optional Indicator component if user wants full control
export const ProgressIndicator = defineComponent({
    name: 'ProgressIndicator',
    props: {
        value: Number,
        max: Number
    },
    setup() {
        // ... similar logic
        return () => h('div');
    }
});
