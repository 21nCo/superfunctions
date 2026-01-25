<script lang="ts">
  import { getContext, setContext } from 'svelte';

  interface Props {
    value: string;
    disabled?: boolean;
    children?: import('svelte').Snippet;
    [key: string]: any;
  }

  let { value, disabled = false, children, ...rest }: Props = $props();
  const ctx = getContext<any>('select');

  let isSelected = $derived(ctx.value === value);

  function handleClick(e: MouseEvent) {
    if (disabled) return;
    if (rest.onclick) rest.onclick(e);
    if (!e.defaultPrevented) {
      ctx.setValue(value);
    }
  }

  function handleKeyDown(e: KeyboardEvent) {
      if (disabled) return;
      if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          ctx.setValue(value);
      }
  }

  setContext('select-item', {
      get isSelected() { return isSelected; }
  });
</script>

<div
  role="option"
  aria-selected={isSelected}
  aria-disabled={disabled}
  data-state={isSelected ? 'checked' : 'unchecked'}
  data-disabled={disabled ? '' : undefined}
  tabindex={disabled ? -1 : 0}
  style:cursor={disabled ? 'not-allowed' : 'pointer'}
  style:padding="5px 10px"
  style:outline="none"
  {...rest}
  onclick={handleClick}
  onkeydown={handleKeyDown}
>
  {@render children?.()}
</div>
