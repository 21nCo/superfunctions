import { defineComponent, h, PropType, toRefs, provide, inject, Ref, computed, useId } from 'vue';
import { useControllableState } from './hooks/use-controllable-state';

/* -------------------------------------------------------------------------------------------------
 * Tabs Root
 * -----------------------------------------------------------------------------------------------*/

const TabsSymbol = Symbol('Tabs');

interface TabsContext {
  value: Ref<string>;
  onValueChange: (val: string) => void;
  orientation: 'horizontal' | 'vertical';
  activationMode: 'automatic' | 'manual';
  baseId: string;
}

export const Tabs = defineComponent({
  name: 'Tabs',
  props: {
    value: {
      type: String,
      default: undefined
    },
    defaultValue: {
      type: String,
      default: undefined
    },
    orientation: {
      type: String as PropType<'horizontal' | 'vertical'>,
      default: 'horizontal'
    },
    activationMode: {
      type: String as PropType<'automatic' | 'manual'>,
      default: 'automatic'
    }
  },
  emits: ['update:value', 'valueChange'],
  setup(props, { slots, emit }) {
    const { value: valueProp, defaultValue, orientation, activationMode } = toRefs(props);

    const value = useControllableState({
      prop: valueProp,
      defaultProp: defaultValue.value ?? '',
      emit,
      name: 'value'
    });

    const baseId = useId();

    provide(TabsSymbol, {
      value,
      onValueChange: (val: string) => { value.value = val; },
      orientation: orientation.value,
      activationMode: activationMode.value,
      baseId: baseId || 'tabs'
    });

    return () => h('div', {
      'data-orientation': orientation.value
    }, slots.default?.());
  }
});

/* -------------------------------------------------------------------------------------------------
 * Tabs List
 * -----------------------------------------------------------------------------------------------*/

export const TabsList = defineComponent({
  name: 'TabsList',
  props: {
    loop: {
      type: Boolean,
      default: true
    }
  },
  setup(_, { slots }) {
    const context = inject<TabsContext>(TabsSymbol);
    if (!context) throw new Error('TabsList must be used within Tabs');

    return () => h('div', {
      role: 'tablist',
      'aria-orientation': context.orientation
    }, slots.default?.());
  }
});

/* -------------------------------------------------------------------------------------------------
 * Tabs Trigger
 * -----------------------------------------------------------------------------------------------*/

export const TabsTrigger = defineComponent({
  name: 'TabsTrigger',
  props: {
    value: {
      type: String,
      required: true
    },
    disabled: {
      type: Boolean,
      default: false
    }
  },
  setup(props, { slots }) {
    const context = inject<TabsContext>(TabsSymbol);
    if (!context) throw new Error('TabsTrigger must be used within Tabs');

    const isSelected = computed(() => context.value.value === props.value);
    const triggerId = computed(() => `${context.baseId}-trigger-${props.value}`);
    const contentId = computed(() => `${context.baseId}-content-${props.value}`);

    const handleClick = () => {
      if (!props.disabled) {
        context.onValueChange(props.value);
      }
    };

    const handleFocus = () => {
      if (!props.disabled && context.activationMode === 'automatic') {
        context.onValueChange(props.value);
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
        // Basic keyboard support (Roving focus ideally, but simplified here)
        if (props.disabled) return;
        if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            context.onValueChange(props.value);
        }
    };

    return () => h('button', {
      type: 'button',
      role: 'tab',
      'aria-selected': isSelected.value,
      'aria-controls': contentId.value,
      id: triggerId.value,
      'data-state': isSelected.value ? 'active' : 'inactive',
      'data-disabled': props.disabled ? '' : undefined,
      disabled: props.disabled,
      tabindex: isSelected.value ? 0 : -1,
      onClick: handleClick,
      onFocus: handleFocus,
      onKeydown: handleKeyDown
    }, slots.default?.());
  }
});

/* -------------------------------------------------------------------------------------------------
 * Tabs Content
 * -----------------------------------------------------------------------------------------------*/

export const TabsContent = defineComponent({
  name: 'TabsContent',
  props: {
    value: {
      type: String,
      required: true
    }
  },
  setup(props, { slots }) {
    const context = inject<TabsContext>(TabsSymbol);
    if (!context) throw new Error('TabsContent must be used within Tabs');

    const isSelected = computed(() => context.value.value === props.value);
    const triggerId = computed(() => `${context.baseId}-trigger-${props.value}`);
    const contentId = computed(() => `${context.baseId}-content-${props.value}`);

    return () => isSelected.value ? h('div', {
      role: 'tabpanel',
      id: contentId.value,
      'aria-labelledby': triggerId.value,
      'data-state': 'active',
      'data-orientation': context.orientation,
      tabindex: 0
    }, slots.default?.()) : null;
  }
});
