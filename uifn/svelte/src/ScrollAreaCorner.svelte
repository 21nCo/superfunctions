<script lang="ts">
  interface Props {
    class?: string;
  }
  let { class: className, ...rest }: Props = $props();
</script>

<div
  class={className}
  style="position: absolute; right: 0; bottom: 0; width: 10px; height: 10px; background: transparent;"
  {...rest}
></div>
