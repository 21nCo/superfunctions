<script lang="ts">
  import { createCheckbox } from '@uifn/core/primitives/checkbox';
  import { setContext } from 'svelte';

  interface Props {
    checked?: boolean | 'indeterminate';
    defaultChecked?: boolean | 'indeterminate';
    disabled?: boolean;
    required?: boolean;
    name?: string;
    value?: string;
    onCheckedChange?: (checked: boolean | 'indeterminate') => void;
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

  const machine = createCheckbox({
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

  function handleClick(e: MouseEvent) {
    if (disabled) return;
    machine.actions.toggle();
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (disabled) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      // machine.actions.toggle(); // Checkbox usually doesn't toggle on Enter, mostly Space (handled by button role)
      // But button type="button" handles Space and Enter click event natively?
      // Actually standard checkbox toggles on Space.
    }
  }

  setContext('checkbox', {
    get checked() { return state.checked; },
    get disabled() { return state.disabled; }
  });
</script>

<button
  type="button"
  role="checkbox"
  aria-checked={state.checked === 'indeterminate' ? 'mixed' : state.checked}
  aria-required={required}
  data-state={state.checked === 'indeterminate' ? 'indeterminate' : (state.checked ? 'checked' : 'unchecked')}
  data-disabled={disabled ? '' : undefined}
  disabled={disabled}
  value={value}
  onclick={handleClick}
  onkeydown={handleKeyDown}
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
    checked={state.checked === true}
    {name}
    {value}
    {required}
    style="transform: translateX(-100%); position: absolute; pointer-events: none; opacity: 0; margin: 0;"
  />
{/if}
