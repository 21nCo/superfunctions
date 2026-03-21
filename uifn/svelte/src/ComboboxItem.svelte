<script lang="ts">
  import { onMount } from 'svelte';
  import { getContext, setContext } from 'svelte';

  interface Props {
    value: string;
    disabled?: boolean;
    children?: import('svelte').Snippet;
    [key: string]: any;
  }

  let { value, disabled = false, children, ...rest }: Props = $props();
  const ctx = getContext<any>('combobox');

  let isSelected = $derived(ctx.value === value);

  onMount(() => {
    ctx.registerItem?.({ value, disabled });
  });

  function handleClick(e: MouseEvent) {
    if (disabled) return;
    if (rest.onclick) rest.onclick(e);
    if (!e.defaultPrevented) {
      ctx.setValue(value);
    }
  }

  setContext('combobox-item', {
      get isSelected() { return isSelected; }
  });
</script>

<div
  role="option"
  aria-selected={isSelected}
  aria-disabled={disabled}
  data-state={isSelected ? 'checked' : 'unchecked'}
  data-disabled={disabled ? '' : undefined}
  style:cursor={disabled ? 'not-allowed' : 'pointer'}
  style:padding="5px 10px"
  {...rest}
  onclick={handleClick}
>
  {@render children?.()}
</div>
