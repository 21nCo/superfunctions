import { defineComponent, h, PropType, toRefs, provide, inject, computed, Ref } from 'vue';
import { useControllableState } from './hooks/use-controllable-state';
import { AccordionType } from '@uifn/core/primitives/accordion';

/* -------------------------------------------------------------------------------------------------
 * Accordion Root
 * -----------------------------------------------------------------------------------------------*/

const AccordionSymbol = Symbol('Accordion');

interface AccordionContext {
  value: Ref<string | string[]>;
  type: AccordionType;
  collapsible: boolean;
  disabled: boolean;
  onItemOpen: (val: string) => void;
  onItemClose: (val: string) => void;
}

export const Accordion = defineComponent({
  name: 'Accordion',
  props: {
    type: {
      type: String as PropType<AccordionType>,
      default: 'single'
    },
    value: {
      type: [String, Array] as PropType<string | string[]>,
      default: undefined
    },
    defaultValue: {
      type: [String, Array] as PropType<string | string[]>,
      default: undefined
    },
    collapsible: {
      type: Boolean,
      default: false
    },
    disabled: {
      type: Boolean,
      default: false
    }
  },
  emits: ['update:value', 'valueChange'],
  setup(props, { slots, emit }) {
    const { value: valueProp, defaultValue, type, collapsible, disabled } = toRefs(props);

    const value = useControllableState({
      prop: valueProp,
      defaultProp: defaultValue.value !== undefined ? defaultValue.value : (type.value === 'multiple' ? [] : ''),
      emit,
      name: 'value'
    });

    const onItemOpen = (itemValue: string) => {
      if (type.value === 'single') {
        value.value = itemValue;
      } else {
        const current = Array.isArray(value.value) ? value.value : [];
        value.value = [...current, itemValue];
      }
    };

    const onItemClose = (itemValue: string) => {
      if (type.value === 'single') {
        if (collapsible.value) {
          value.value = '';
        }
      } else {
        const current = Array.isArray(value.value) ? value.value : [];
        value.value = current.filter((v: string) => v !== itemValue);
      }
    };

    provide(AccordionSymbol, {
      value,
      type: type.value,
      collapsible: collapsible.value,
      disabled: disabled.value,
      onItemOpen,
      onItemClose
    });

    return () => h('div', {
      'data-orientation': 'vertical'
    }, slots.default?.());
  }
});

/* -------------------------------------------------------------------------------------------------
 * Accordion Item
 * -----------------------------------------------------------------------------------------------*/

const AccordionItemSymbol = Symbol('AccordionItem');

export const AccordionItem = defineComponent({
  name: 'AccordionItem',
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
    const accordionContext = inject<AccordionContext>(AccordionSymbol);
    
    if (!accordionContext) throw new Error('AccordionItem must be used within Accordion');

    const open = computed(() => {
      if (accordionContext.type === 'single') {
        return accordionContext.value.value === props.value;
      } else {
        return (accordionContext.value.value as string[]).includes(props.value);
      }
    });

    const disabled = computed(() => accordionContext.disabled || props.disabled);

    provide(AccordionItemSymbol, {
      value: props.value,
      open,
      disabled
    });

    return () => h('div', {
      'data-state': open.value ? 'open' : 'closed',
      'data-disabled': disabled.value ? '' : undefined
    }, slots.default?.());
  }
});

/* -------------------------------------------------------------------------------------------------
 * Accordion Trigger
 * -----------------------------------------------------------------------------------------------*/

export const AccordionTrigger = defineComponent({
  name: 'AccordionTrigger',
  setup(_, { slots }) {
    const itemContext = inject<{ value: string, open: Ref<boolean>, disabled: Ref<boolean> }>(AccordionItemSymbol);
    const accordionContext = inject<AccordionContext>(AccordionSymbol);

    if (!itemContext || !accordionContext) throw new Error('AccordionTrigger must be used within AccordionItem');

    const handleClick = () => {
      if (itemContext.disabled.value) return;
      if (itemContext.open.value) {
        accordionContext.onItemClose(itemContext.value);
      } else {
        accordionContext.onItemOpen(itemContext.value);
      }
    };

    return () => h('h3', { style: { margin: 0 } }, [
      h('button', {
        type: 'button',
        'aria-expanded': itemContext.open.value,
        'aria-disabled': itemContext.disabled.value,
        'data-state': itemContext.open.value ? 'open' : 'closed',
        'data-disabled': itemContext.disabled.value ? '' : undefined,
        onClick: handleClick
      }, slots.default?.())
    ]);
  }
});

/* -------------------------------------------------------------------------------------------------
 * Accordion Content
 * -----------------------------------------------------------------------------------------------*/

export const AccordionContent = defineComponent({
  name: 'AccordionContent',
  setup(_, { slots }) {
    const itemContext = inject<{ open: Ref<boolean>, disabled: Ref<boolean> }>(AccordionItemSymbol);
    if (!itemContext) throw new Error('AccordionContent must be used within AccordionItem');

    return () => h('div', {
      role: 'region',
      'data-state': itemContext.open.value ? 'open' : 'closed',
      'data-disabled': itemContext.disabled.value ? '' : undefined,
      hidden: !itemContext.open.value
    }, slots.default?.());
  }
});
