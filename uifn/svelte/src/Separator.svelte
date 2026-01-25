<script lang="ts">
  interface Props {
    orientation?: 'horizontal' | 'vertical';
    decorative?: boolean;
    class?: string;
  }

  let { orientation = 'horizontal', decorative = false, class: className, ...rest }: Props = $props();
</script>

<div
  role={decorative ? 'none' : 'separator'}
  aria-orientation={decorative ? undefined : orientation}
  data-orientation={orientation}
  class={className}
  {...rest}
></div>
