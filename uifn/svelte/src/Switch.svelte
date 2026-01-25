<script lang="ts">
  import { createSwitch } from '@uifn/core/primitives/switch';
  import { setContext } from 'svelte';

  interface Props {
    checked?: boolean;
    defaultChecked?: boolean;
    disabled?: boolean;
    required?: boolean;
    name?: string;
    value?: string;
    onCheckedChange?: (checked: boolean) => void;
    children?: import('svelte').Snippet;
    class?: string;
  }

  let {
    checked: checkedProp,
    defaultChecked,
    disabled = false,
    required = false,
    name,
    value,
    onCheckedChange,
    children,
    class: className,
    ...rest
  }: Props = $props();

  const machine = createSwitch({
    checked: checkedProp,
    defaultChecked,
    disabled,
    required,
    onCheckedChange
  });

  let state = $state(machine.state);

  $effect(() => {
    return machine.subscribe((newState) => {
      state = newState;
    });
  });

  function handleClick() {
    if (disabled) return;
    machine.actions.toggle();
  }

  setContext('switch', {
    get checked() { return state.checked; },
    get disabled() { return state.disabled; }
  });
</script>

<button
  type="button"
  role="switch"
  aria-checked={state.checked}
  aria-required={required}
  data-state={state.checked ? 'checked' : 'unchecked'}
  data-disabled={disabled ? '' : undefined}
  disabled={disabled}
  value={value}
  onclick={handleClick}
  class={className}
  {...rest}
>
  {@render children?.()}
</button>

{#if name && state.checked}
  <input
    type="checkbox"
    aria-hidden="true"
    hidden
    checked
    {name}
    {value}
    {required}
    style="transform: translateX(-100%); position: absolute; pointer-events: none; opacity: 0; margin: 0;"
  />
{/if}
