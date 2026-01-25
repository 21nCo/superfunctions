<script lang="ts">
  import ScrollArea from '../ScrollArea.svelte';
  import ScrollAreaViewport from '../ScrollAreaViewport.svelte';
  import ScrollAreaScrollbar from '../ScrollAreaScrollbar.svelte';
  import ScrollAreaThumb from '../ScrollAreaThumb.svelte';
  import ScrollAreaCorner from '../ScrollAreaCorner.svelte';
</script>

<ScrollArea>
  <ScrollAreaViewport>
    <div style="height: 200px; width: 200px;">Content</div>
  </ScrollAreaViewport>
  <ScrollAreaScrollbar orientation="vertical">
    <ScrollAreaThumb />
  </ScrollAreaScrollbar>
  <ScrollAreaCorner />
</ScrollArea>
