<script lang="ts">
  import { getContext } from 'svelte';

  interface Props {
    value: string;
    disabled?: boolean;
    children?: import('svelte').Snippet;
    class?: string;
  }

  let { value, disabled = false, children, class: className, ...rest }: Props = $props();

  const context = getContext<any>('toggle-group');

  let pressed = $derived(
    context.type === 'single'
      ? context.value === value
      : (context.value as string[]).includes(value)
  );

  let isDisabled = $derived(context.disabled || disabled);

  function handleClick() {
    if (isDisabled) return;
    context.toggleItem(value);
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (isDisabled) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      context.toggleItem(value);
    }
  }
</script>

<button
  type="button"
  role={context.type === 'single' ? 'radio' : 'button'}
  aria-checked={context.type === 'single' ? pressed : undefined}
  aria-pressed={context.type === 'multiple' ? pressed : undefined}
  data-state={pressed ? 'on' : 'off'}
  data-disabled={isDisabled ? '' : undefined}
  disabled={isDisabled}
  tabindex={context.rovingFocus ? (pressed ? 0 : -1) : 0}
  onclick={handleClick}
  onkeydown={handleKeyDown}
  class={className}
  {...rest}
>
  {@render children?.()}
</button>
