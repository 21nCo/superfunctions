import { defineComponent, h, provide, inject, ref, Teleport, Ref } from 'vue';
import { useOutsideClick } from './hooks/use-outside-click';
import { useEscapeKeydown } from './hooks/use-escape-keydown';

/* -------------------------------------------------------------------------------------------------
 * ContextMenu Root
 * -----------------------------------------------------------------------------------------------*/

const ContextMenuSymbol = Symbol('ContextMenu');

interface ContextMenuContext {
  open: Ref<boolean>;
  onOpenChange: (val: boolean) => void;
  contentRef: Ref<HTMLElement | undefined>;
  point: Ref<{ x: number, y: number }>;
}

export const ContextMenu = defineComponent({
  name: 'ContextMenu',
  emits: ['openChange'],
  setup(_, { slots, emit }) {
    const open = ref(false);
    const contentRef = ref<HTMLElement>();
    const point = ref({ x: 0, y: 0 });

    provide(ContextMenuSymbol, {
      open,
      onOpenChange: (val: boolean) => {
        open.value = val;
        emit('openChange', val);
      },
      contentRef,
      point
    });

    return () => slots.default?.();
  }
});

/* -------------------------------------------------------------------------------------------------
 * ContextMenu Trigger
 * -----------------------------------------------------------------------------------------------*/

export const ContextMenuTrigger = defineComponent({
  name: 'ContextMenuTrigger',
  props: {
    disabled: {
      type: Boolean,
      default: false
    }
  },
  setup(props, { slots }) {
    const context = inject<ContextMenuContext>(ContextMenuSymbol);
    if (!context) throw new Error('ContextMenuTrigger must be used within ContextMenu');

    const handleContextMenu = (e: MouseEvent) => {
      if (props.disabled) return;
      e.preventDefault();
      context.point.value = { x: e.clientX, y: e.clientY };
      context.onOpenChange(true);
    };

    return () => h('div', {
      onContextmenu: handleContextMenu,
      style: { display: 'contents' }
    }, slots.default?.());
  }
});

/* -------------------------------------------------------------------------------------------------
 * ContextMenu Content
 * -----------------------------------------------------------------------------------------------*/

export const ContextMenuContent = defineComponent({
  name: 'ContextMenuContent',
  setup(_, { slots }) {
    const context = inject<ContextMenuContext>(ContextMenuSymbol);
    if (!context) throw new Error('ContextMenuContent must be used within ContextMenu');

    useOutsideClick(context.contentRef, () => {
      context.onOpenChange(false);
    }, context.open);

    useEscapeKeydown(() => {
      if (context.open.value) context.onOpenChange(false);
    });

    return () => {
      if (!context.open.value) return null;

      return h(Teleport, { to: 'body' }, [
        h('div', {
          ref: context.contentRef,
          role: 'menu',
          'data-state': 'open',
          style: {
            position: 'fixed',
            left: `${context.point.value.x}px`,
            top: `${context.point.value.y}px`,
            zIndex: 50,
            backgroundColor: 'white',
            border: '1px solid #ccc',
            borderRadius: '4px',
            padding: '5px 0',
            minWidth: '150px'
          }
        }, slots.default?.())
      ]);
    };
  }
});

/* -------------------------------------------------------------------------------------------------
 * ContextMenu Item
 * -----------------------------------------------------------------------------------------------*/

export const ContextMenuItem = defineComponent({
  name: 'ContextMenuItem',
  props: {
    disabled: {
      type: Boolean,
      default: false
    }
  },
  emits: ['select'],
  setup(props, { slots, emit }) {
    const context = inject<ContextMenuContext>(ContextMenuSymbol);

    const handleSelect = (e: Event) => {
      if (props.disabled) return;
      emit('select', e);
      if (!e.defaultPrevented) {
        context?.onOpenChange(false);
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (props.disabled) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleSelect(e);
      }
    };

    return () => h('div', {
      role: 'menuitem',
      'aria-disabled': props.disabled,
      'data-disabled': props.disabled ? '' : undefined,
      tabindex: props.disabled ? -1 : 0,
      onClick: handleSelect,
      onKeydown: handleKeyDown,
      style: {
        padding: '5px 10px',
        cursor: props.disabled ? 'not-allowed' : 'pointer',
        opacity: props.disabled ? 0.5 : 1,
        outline: 'none'
      }
    }, slots.default?.());
  }
});