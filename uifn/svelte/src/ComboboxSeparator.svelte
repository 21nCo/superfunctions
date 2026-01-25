<script lang="ts">
  interface Props {
    [key: string]: any;
  }
  let { ...rest }: Props = $props();
</script>

<div style:height="1px" style:background-color="#eee" style:margin="5px 0" {...rest}></div>
