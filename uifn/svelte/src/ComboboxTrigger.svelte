<script lang="ts">
  import { onMount } from 'svelte';
  import { getRequiredContext } from './internal/context';

  interface ComboboxContext {
    open: boolean;
    disabled: boolean;
    contentId: string;
    input: HTMLInputElement | null;
    registerTrigger: (el: HTMLElement) => void;
    setOpen: (value: boolean) => void;
  }

  interface Props {
    children?: import('svelte').Snippet;
    [key: string]: any;
  }

  let { children, ...rest }: Props = $props();
  const ctx = getRequiredContext<ComboboxContext>(
    'combobox',
    'ComboboxTrigger',
    'Combobox components must be used within a Combobox'
  );
  let el: HTMLElement;

  onMount(() => {
    if (el) ctx.registerTrigger(el);
  });

  function handleClick(e: MouseEvent) {
    if (ctx.disabled) return;
    if (rest.onclick) rest.onclick(e);
    if (!e.defaultPrevented) {
      ctx.setOpen(!ctx.open);
      if (!ctx.open) {
          ctx.input?.focus();
      }
    }
  }
</script>

<button
  bind:this={el}
  type="button"
  aria-haspopup="listbox"
  aria-expanded={ctx.open}
  aria-controls={ctx.open ? ctx.contentId : undefined}
  data-state={ctx.open ? 'open' : 'closed'}
  data-disabled={ctx.disabled ? '' : undefined}
  disabled={ctx.disabled}
  tabindex="-1"
  {...rest}
  onclick={handleClick}
>
  {@render children?.()}
</button>
