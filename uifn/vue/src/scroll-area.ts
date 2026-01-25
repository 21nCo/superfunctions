import { defineComponent, h, PropType, provide, inject, ref, Ref } from 'vue';

/* -------------------------------------------------------------------------------------------------
 * ScrollArea Root
 * -----------------------------------------------------------------------------------------------*/

const ScrollAreaSymbol = Symbol('ScrollArea');

interface ScrollAreaContext {
  viewport: Ref<HTMLElement | undefined>;
}

export const ScrollArea = defineComponent({
  name: 'ScrollArea',
  setup(_, { slots }) {
    const viewport = ref<HTMLElement>();

    provide(ScrollAreaSymbol, {
      viewport
    });

    return () => h('div', {
      dir: 'ltr',
      style: { position: 'relative', overflow: 'hidden' }
    }, slots.default?.());
  }
});

/* -------------------------------------------------------------------------------------------------
 * ScrollArea Viewport
 * -----------------------------------------------------------------------------------------------*/

export const ScrollAreaViewport = defineComponent({
  name: 'ScrollAreaViewport',
  setup(_, { slots }) {
    const context = inject<ScrollAreaContext>(ScrollAreaSymbol);
    if (!context) throw new Error('ScrollAreaViewport must be used within ScrollArea');

    return () => h('div', {
      ref: context.viewport,
      style: { width: '100%', height: '100%', borderRadius: 'inherit', overflow: 'scroll' }
    }, slots.default?.());
  }
});

/* -------------------------------------------------------------------------------------------------
 * ScrollArea Scrollbar
 * -----------------------------------------------------------------------------------------------*/

export const ScrollAreaScrollbar = defineComponent({
  name: 'ScrollAreaScrollbar',
  props: {
    orientation: {
      type: String as PropType<'horizontal' | 'vertical'>,
      default: 'vertical'
    }
  },
  setup(props, { slots }) {
    return () => h('div', {
      role: 'scrollbar',
      'data-orientation': props.orientation,
      style: {
        display: 'flex',
        userSelect: 'none',
        touchAction: 'none',
        position: 'absolute',
        ...(props.orientation === 'vertical' 
          ? { right: '0', width: '10px', height: '100%' } 
          : { bottom: '0', height: '10px', width: '100%' })
      }
    }, slots.default?.());
  }
});

/* -------------------------------------------------------------------------------------------------
 * ScrollArea Thumb
 * -----------------------------------------------------------------------------------------------*/

export const ScrollAreaThumb = defineComponent({
  name: 'ScrollAreaThumb',
  setup() {
    return () => h('div', {
      style: { flex: '1', background: 'rgba(0,0,0,0.3)', borderRadius: '10px', position: 'relative' }
    });
  }
});

export const ScrollAreaCorner = defineComponent({
  name: 'ScrollAreaCorner',
  setup() {
    return () => h('div', {
      style: { position: 'absolute', right: '0', bottom: '0', width: '10px', height: '10px', background: 'transparent' }
    });
  }
});
