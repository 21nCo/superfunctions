<script lang="ts">
  import { portal as portalAction } from './internal/portal';

  interface Props {
    class?: string;
    children?: import('svelte').Snippet;
  }
  let { class: className, children, ...rest }: Props = $props();
</script>

<div use:portalAction={'body'}>
  <div
    role="region"
    aria-label="Notifications"
    class={className}
    style="position: fixed; bottom: 0; right: 0; display: flex; flexDirection: column; padding: 25px; gap: 10px; width: 390px; maxWidth: 100vw; margin: 0; listStyle: none; zIndex: 2147483647; outline: none;"
    {...rest}
  >
    {@render children?.()}
  </div>
</div>
