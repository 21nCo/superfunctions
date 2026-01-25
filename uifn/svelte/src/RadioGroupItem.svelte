<script lang="ts">
  import { getContext, setContext } from 'svelte';

  interface Props {
    value: string;
    disabled?: boolean;
    children?: import('svelte').Snippet;
    class?: string;
  }

  let { value, disabled = false, children, class: className, ...rest }: Props = $props();

  const group = getContext<any>('radio-group');

  let checked = $derived(group.value === value);
  let itemDisabled = $derived(group.disabled || disabled);

  function handleClick() {
    if (itemDisabled) return;
    group.setValue(value);
  }

  function handleKeyDown(e: KeyboardEvent) {
      // Basic keyboard support
      // Roving focus ideally
      if (itemDisabled) return;
      if (e.key === ' ') {
          e.preventDefault();
          group.setValue(value);
      }
  }

  setContext('radio-group-item', { checked, disabled: itemDisabled });
</script>

<button
  type="button"
  role="radio"
  aria-checked={checked}
  data-state={checked ? 'checked' : 'unchecked'}
  data-disabled={itemDisabled ? '' : undefined}
  disabled={itemDisabled}
  value={value}
  tabindex={checked ? 0 : -1} 
  onclick={handleClick}
  onkeydown={handleKeyDown}
  class={className}
  {...rest}
>
  {@render children?.()}
</button>

{#if group.name && checked}
  <input
    type="radio"
    aria-hidden="true"
    hidden
    checked
    name={group.name}
    {value}
    style="transform: translateX(-100%); position: absolute; pointer-events: none; opacity: 0; margin: 0;"
    tabindex="-1"
  />
{/if}
