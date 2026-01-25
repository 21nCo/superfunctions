<script lang="ts">
  export let width = 800;
  export let height = 600;
  
  let className = '';
  export { className as class };
</script>

<canvas
  bind:this={$$restProps.canvas}
  {width}
  {height}
  class={className}
  style="display: block; touch-action: none; {$$restProps.style || ''}"
  {...$$restProps}
/>
