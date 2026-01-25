import { defineComponent, h, PropType, toRefs, provide, inject, ref, Ref, computed } from 'vue';
import { useControllableState } from './hooks/use-controllable-state';
import { usePosition, Side, Align } from './hooks/use-position';
import { useOutsideClick } from './hooks/use-outside-click';
import { Teleport } from 'vue';

/* -------------------------------------------------------------------------------------------------
 * MenuBar Root
 * -----------------------------------------------------------------------------------------------*/

const MenuBarSymbol = Symbol('MenuBar');

interface MenuBarContext {
  value: Ref<string>;
  onValueChange: (val: string) => void;
  autoSelect: boolean;
}

export const MenuBar = defineComponent({
  name: 'MenuBar',
  props: {
    value: {
      type: String,
      default: undefined
    },
    defaultValue: {
      type: String,
      default: ''
    }
  },
  emits: ['update:value', 'valueChange'],
  setup(props, { slots, emit }) {
    const { value: valueProp, defaultValue } = toRefs(props);

    const value = useControllableState({
      prop: valueProp,
      defaultProp: defaultValue.value,
      emit,
      name: 'value'
    });

    provide(MenuBarSymbol, {
      value,
      onValueChange: (val: string) => { value.value = val; },
      autoSelect: true // Simplified
    });

    return () => h('div', {
      role: 'menubar'
    }, slots.default?.());
  }
});

/* -------------------------------------------------------------------------------------------------
 * MenuBar Menu
 * -----------------------------------------------------------------------------------------------*/

const MenuBarMenuSymbol = Symbol('MenuBarMenu');

export const MenuBarMenu = defineComponent({
  name: 'MenuBarMenu',
  props: {
    value: {
      type: String,
      required: true
    }
  },
  setup(props, { slots }) {
    const menubarContext = inject<MenuBarContext>(MenuBarSymbol);
    if (!menubarContext) throw new Error('MenuBarMenu must be used within MenuBar');

    const open = computed(() => menubarContext.value.value === props.value);
    const triggerRef = ref<HTMLElement>();
    const contentRef = ref<HTMLElement>();

    provide(MenuBarMenuSymbol, {
      value: props.value,
      open,
      triggerRef,
      contentRef
    });

    return () => slots.default?.();
  }
});

/* -------------------------------------------------------------------------------------------------
 * MenuBar Trigger
 * -----------------------------------------------------------------------------------------------*/

export const MenuBarTrigger = defineComponent({
  name: 'MenuBarTrigger',
  setup(_, { slots }) {
    const menubarContext = inject<MenuBarContext>(MenuBarSymbol);
    const menuContext = inject<{ value: string, open: Ref<boolean>, triggerRef: Ref<HTMLElement | undefined> }>(MenuBarMenuSymbol);
    
    if (!menuContext) throw new Error('MenuBarTrigger must be used within MenuBarMenu');

    const handleClick = () => {
      if (menuContext.open.value) {
        menubarContext?.onValueChange('');
      } else {
        menubarContext?.onValueChange(menuContext.value);
      }
    };

    const handleMouseEnter = () => {
      if (menubarContext?.value.value && !menuContext.open.value) {
        menubarContext.onValueChange(menuContext.value);
      }
    };

    return () => h('button', {
      type: 'button',
      ref: menuContext.triggerRef,
      role: 'menuitem',
      'aria-haspopup': 'menu',
      'aria-expanded': menuContext.open.value,
      'data-state': menuContext.open.value ? 'open' : 'closed',
      onClick: handleClick,
      onMouseenter: handleMouseEnter
    }, slots.default?.());
  }
});

/* -------------------------------------------------------------------------------------------------
 * MenuBar Content
 * -----------------------------------------------------------------------------------------------*/

export const MenuBarContent = defineComponent({
  name: 'MenuBarContent',
  props: {
    side: {
      type: String as PropType<Side>,
      default: 'bottom'
    },
    align: {
      type: String as PropType<Align>,
      default: 'start'
    },
    sideOffset: {
      type: Number,
      default: 5
    },
    alignOffset: {
      type: Number,
      default: 0
    }
  },
  setup(props, { slots }) {
    const menubarContext = inject<MenuBarContext>(MenuBarSymbol);
    const menuContext = inject<{ open: Ref<boolean>, triggerRef: Ref<HTMLElement | undefined>, contentRef: Ref<HTMLElement | undefined> }>(MenuBarMenuSymbol);
    
    if (!menuContext) throw new Error('MenuBarContent must be used within MenuBarMenu');

    const { style } = usePosition(menuContext.triggerRef, menuContext.contentRef, {
      side: props.side,
      align: props.align,
      sideOffset: props.sideOffset,
      alignOffset: props.alignOffset
    });

    useOutsideClick(menuContext.contentRef, (e) => {
      if (menuContext.triggerRef.value?.contains(e.target as Node)) return;
      menubarContext?.onValueChange('');
    }, menuContext.open);

    return () => {
      if (!menuContext.open.value) return null;

      return h(Teleport, { to: 'body' }, [
        h('div', {
          ref: menuContext.contentRef,
          role: 'menu',
          'data-state': 'open',
          style: {
            ...style.value,
            zIndex: 50,
            backgroundColor: 'white',
            border: '1px solid #ccc',
            minWidth: '150px'
          }
        }, slots.default?.())
      ]);
    };
  }
});
