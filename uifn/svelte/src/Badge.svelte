<script lang="ts">
  interface Props {
    variant?: 'default' | 'secondary' | 'outline' | 'destructive';
    children?: import('svelte').Snippet;
    class?: string;
  }

  let { variant = 'default', children, class: className, ...rest }: Props = $props();
</script>

<span
  role="status"
  data-variant={variant}
  class={className}
  style="display: inline-flex; align-items: center; border-radius: 9999px; padding: 2px 8px; font-size: 12px; font-weight: 600;"
  {...rest}
>
  {@render children?.()}
</span>
