<script lang="ts">
  import { isOutsideEventTarget } from './internal/dismissible';
  import { getRequiredContext } from './internal/context';
  import { portal } from './internal/portal';
  import { position, type Side, type Align } from './internal/position';
  import { focusTrap } from './internal/focus-trap';

  interface SelectContext {
    open: boolean;
    contentId: string;
    highlightedItem: string | null;
    trigger: HTMLElement | null;
    setOpen: (value: boolean) => void;
    focusOption: (value: string | null | undefined) => void;
    handleKeyDown: (key: string, currentItem?: string | null) => string | null;
  }

  interface Props {
    children?: import('svelte').Snippet;
    side?: Side;
    align?: Align;
    sideOffset?: number;
    alignOffset?: number;
    position?: 'item-aligned' | 'popper';
    [key: string]: any;
  }

  let { 
    children, 
    side = 'bottom', 
    align = 'start', 
    sideOffset = 0, 
    alignOffset = 0,
    position: positionMode = 'item-aligned',
    ...rest 
  }: Props = $props();

  const ctx = getRequiredContext<SelectContext>(
    'select',
    'SelectContent',
    'Select components must be used within a Select'
  );
  let contentEl: HTMLDivElement;

  function handleKeyDown(e: KeyboardEvent) {
    e.preventDefault();
    const currentItem =
      (document.activeElement as HTMLElement | null)?.dataset.value ?? ctx.highlightedItem;
    const nextItem = ctx.handleKeyDown(e.key, currentItem);
    if (nextItem) {
      queueMicrotask(() => {
        ctx.focusOption(nextItem);
      });
    }
  }

  $effect(() => {
    if (!ctx.open) {
      return;
    }

    queueMicrotask(() => {
      ctx.focusOption(ctx.highlightedItem);
    });

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!isOutsideEventTarget(target, [contentEl, ctx.trigger])) {
        return;
      }

      ctx.setOpen(false);
    };

    document.addEventListener('pointerdown', handlePointerDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
    };
  });
</script>

<div use:portal>
  <div
    bind:this={contentEl}
    role="listbox"
    id={ctx.contentId}
    data-state={ctx.open ? 'open' : 'closed'}
    hidden={!ctx.open}
    use:position={{
      trigger: ctx.trigger,
      side,
      align,
      sideOffset,
      alignOffset
    }}
    use:focusTrap={{ active: ctx.open, returnFocus: true }}
    style="z-index: 50; background-color: white; border: 1px solid #ccc; border-radius: 4px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); min-width: 100px; display: {ctx.open ? 'block' : 'none'};"
    {...rest}
    onkeydown={handleKeyDown}
    tabindex="-1"
  >
    {@render children?.()}
  </div>
</div>
