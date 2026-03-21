<script lang="ts">
  import VirtualizedList from '../VirtualizedList.svelte';

  let { itemCount = 200, itemHeight = 20, height = 60, overscan = 3 } = $props();
  const items = Array.from({ length: itemCount }, (_, i) => `Row ${i}`);
</script>

<VirtualizedList {items} {itemHeight} {height} {overscan}>
  {#snippet children(item)}
    <div data-testid="virt-row">{item}</div>
  {/snippet}
</VirtualizedList>
