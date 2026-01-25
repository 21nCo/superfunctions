<script lang="ts">
  import { getContext, setContext } from 'svelte';

  interface Props {
    value: string;
    children?: import('svelte').Snippet;
  }

  let { value, children }: Props = $props();
  const context = getContext<any>('menubar');

  let open = $derived(context.value === value);
  let triggerElement = $state<HTMLElement>();

  setContext('menubar-menu', {
    get value() { return value; },
    get open() { return open; },
    get triggerElement() { return triggerElement; },
    setTriggerElement: (el: HTMLElement) => { triggerElement = el; }
  });
</script>

{@render children?.()}
