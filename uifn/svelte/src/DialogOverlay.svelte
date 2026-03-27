<script lang="ts">
  import { getRequiredContext } from './internal/context';

  interface Props {
    class?: string;
    onClick?: (e: MouseEvent) => void;
  }

  let { class: className, onClick, ...rest }: Props = $props();
  const context = getRequiredContext<any>(
    'dialog',
    'DialogOverlay',
    'Dialog components must be used within Dialog'
  );

  function handleClick(e: MouseEvent) {
    if (context.modal) {
      context.setOpen(false);
    }
    onClick?.(e);
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  data-state={context.open ? 'open' : 'closed'}
  onclick={handleClick}
  class={className}
  style="position: fixed; inset: 0; z-index: 50; background-color: rgba(0,0,0,0.5);"
  {...rest}
></div>
