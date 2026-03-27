<script lang="ts">
  import { setContext } from 'svelte';
  import { getRequiredContext } from './internal/context';

  interface MenuBarContext {
    value: string;
  }

  interface MenuBarMenuContext {
    value: string;
    open: boolean;
    contentId: string;
    triggerElement: HTMLElement | undefined;
    openFocusTarget: 'first' | 'last';
    setTriggerElement: (el: HTMLElement) => void;
    setOpenFocusTarget: (value: 'first' | 'last') => void;
  }

  interface Props {
    value: string;
    children?: import('svelte').Snippet;
  }

  let { value, children }: Props = $props();
  const context = getRequiredContext<MenuBarContext>(
    'menubar',
    'MenuBarMenu',
    'MenuBarMenu must be used within a MenuBar'
  );

  let open = $derived(context.value === value);
  let triggerElement = $state<HTMLElement>();
  let openFocusTarget = $state<'first' | 'last'>('first');

  setContext<MenuBarMenuContext>('menubar-menu', {
    get value() { return value; },
    get open() { return open; },
    get contentId() { return `menubar-content-${value}`; },
    get triggerElement() { return triggerElement; },
    get openFocusTarget() { return openFocusTarget; },
    setTriggerElement: (el: HTMLElement) => { triggerElement = el; },
    setOpenFocusTarget: (nextValue: 'first' | 'last') => { openFocusTarget = nextValue; }
  });
</script>

{@render children?.()}
