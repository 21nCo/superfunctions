<script lang="ts">
  import { createContextMenu } from '@uifn/core/primitives/context-menu';
  import { setContext } from 'svelte';
  import { createSveltePublicId } from './internal/id';

  interface ContextMenuContext {
    open: boolean;
    contentId: string;
    point: { x: number; y: number };
    triggerElement: HTMLElement | undefined;
    setOpen: (value: boolean) => void;
    setPoint: (point: { x: number; y: number }) => void;
    setTriggerElement: (el: HTMLElement) => void;
  }

  interface Props {
    onOpenChange?: (open: boolean) => void;
    children?: import('svelte').Snippet;
  }

  let { onOpenChange, children }: Props = $props();
  const notifyOpenChange = (open: boolean) => onOpenChange?.(open);
  const contentId = createSveltePublicId(undefined, {
    prefix: 'context-menu',
    slot: 'content',
  });

  const machine = createContextMenu({
    onOpenChange: notifyOpenChange
  });

  let state = $state(machine.state);
  let triggerElement = $state<HTMLElement>();
  let point = $state({ x: 0, y: 0 });

  $effect(() => {
    return machine.subscribe((newState) => {
      state = newState;
    });
  });

  function setOpen(val: boolean) {
    machine.actions.setOpen(val);
  }

  setContext<ContextMenuContext>('context-menu', {
    get open() { return state.open; },
    get contentId() { return contentId; },
    get point() { return point; },
    get triggerElement() { return triggerElement; },
    setOpen,
    setPoint: (p: { x: number, y: number }) => { point = p; },
    setTriggerElement: (el: HTMLElement) => { triggerElement = el; }
  });
</script>

{@render children?.()}
