import { defineComponent, h, toRefs, provide, inject } from 'vue';
import { useControllableState } from './hooks/use-controllable-state';

/* -------------------------------------------------------------------------------------------------
 * Collapsible Root
 * -----------------------------------------------------------------------------------------------*/

const CollapsibleSymbol = Symbol('Collapsible');

export const Collapsible = defineComponent({
  name: 'Collapsible',
  props: {
    open: { type: Boolean, default: undefined },
    defaultOpen: { type: Boolean, default: false },
    disabled: { type: Boolean, default: false }
  },
  emits: ['update:open', 'openChange'],
  setup(props, { slots, emit }) {
    const { open: openProp, defaultOpen, disabled } = toRefs(props);
    const open = useControllableState({
      prop: openProp,
      defaultProp: defaultOpen.value,
      emit,
      name: 'open'
    });

    provide(CollapsibleSymbol, {
      open,
      disabled,
      toggle: () => {
        if (disabled.value) return;
        open.value = !open.value;
      }
    });

    return () => h('div', {
      'data-state': open.value ? 'open' : 'closed',
      'data-disabled': disabled.value ? '' : undefined
    }, slots.default?.());
  }
});

/* -------------------------------------------------------------------------------------------------
 * Collapsible Trigger
 * -----------------------------------------------------------------------------------------------*/

export const CollapsibleTrigger = defineComponent({
  name: 'CollapsibleTrigger',
  setup(_, { slots }) {
    const context = inject<any>(CollapsibleSymbol);
    return () => h('button', {
      type: 'button',
      'aria-controls': 'radix-collapsible-content',
      'aria-expanded': context.open.value,
      'data-state': context.open.value ? 'open' : 'closed',
      'data-disabled': context.disabled.value ? '' : undefined,
      disabled: context.disabled.value,
      onClick: context.toggle
    }, slots.default?.());
  }
});

/* -------------------------------------------------------------------------------------------------
 * Collapsible Content
 * -----------------------------------------------------------------------------------------------*/

export const CollapsibleContent = defineComponent({
  name: 'CollapsibleContent',
  setup(_, { slots }) {
    const context = inject<any>(CollapsibleSymbol);
    return () => h('div', {
      'data-state': context.open.value ? 'open' : 'closed',
      'data-disabled': context.disabled.value ? '' : undefined,
      hidden: !context.open.value,
      style: {
          '--radix-collapsible-content-height': 'var(--radix-collapsible-content-height)', // Placeholder for animation
      }
    }, slots.default?.());
  }
});
