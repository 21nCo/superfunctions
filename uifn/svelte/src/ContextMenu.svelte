<script lang="ts">
  import { createContextMenu } from '@uifn/core/primitives/context-menu';
  import { setContext } from 'svelte';

  interface Props {
    onOpenChange?: (open: boolean) => void;
    children?: import('svelte').Snippet;
  }

  let { onOpenChange, children }: Props = $props();

  const machine = createContextMenu({
    onOpenChange
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

  setContext('context-menu', {
    get open() { return state.open; },
    get point() { return point; },
    setOpen,
    setPoint: (p: { x: number, y: number }) => { point = p; }
  });
</script>

{@render children?.()}
