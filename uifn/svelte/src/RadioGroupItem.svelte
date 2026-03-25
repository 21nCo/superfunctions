<script lang="ts">
  import { setContext } from 'svelte';
  import { getRequiredContext } from './internal/context';

  interface Props {
    value: string;
    disabled?: boolean;
    children?: import('svelte').Snippet;
    class?: string;
  }

  let { value, disabled = false, children, class: className, ...rest }: Props = $props();
  const getValue = () => value;

  const group = getRequiredContext<any>(
    'radio-group',
    'RadioGroupItem',
    'RadioGroupItem must be used within RadioGroup'
  );

  let checked = $derived(group.value === getValue());
  let itemDisabled = $derived(group.disabled || disabled);
  let itemDisabledValue = $derived(itemDisabled);

  function handleClick() {
    if (itemDisabledValue) return;
    group.setValue(getValue());
  }

  function handleKeyDown(e: KeyboardEvent) {
      // Basic keyboard support
      // Roving focus ideally
      if (itemDisabledValue) return;
      if (e.key === ' ') {
          e.preventDefault();
          group.setValue(getValue());
      }
  }

  setContext('radio-group-item', {
    get checked() { return checked; },
    get disabled() { return itemDisabledValue; }
  });
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
