<script lang="ts">
  interface Props {
    class?: string;
  }
  let { class: className, ...rest }: Props = $props();
</script>

<div
  class={className}
  style="flex: 1; background: rgba(0,0,0,0.3); border-radius: 10px; position: relative;"
  {...rest}
></div>
