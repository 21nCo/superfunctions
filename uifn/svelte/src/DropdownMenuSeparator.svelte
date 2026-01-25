<script lang="ts">
  interface Props {
    class?: string;
  }

  let { class: className, ...rest }: Props = $props();
</script>

<div
  role="separator"
  class={className}
  style="height: 1px; background-color: #eee; margin: 5px 0;"
  {...rest}
></div>
