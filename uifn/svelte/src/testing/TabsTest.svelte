<script lang="ts">
  import Tabs from '../Tabs.svelte';
  import TabsList from '../TabsList.svelte';
  import TabsTrigger from '../TabsTrigger.svelte';
  import TabsContent from '../TabsContent.svelte';

  let { defaultValue = 'tab1' } = $props();
</script>

<Tabs {defaultValue}>
  <TabsList>
    <TabsTrigger value="tab1">Tab 1</TabsTrigger>
    <TabsTrigger value="tab2">Tab 2</TabsTrigger>
  </TabsList>
  <TabsContent value="tab1">Content 1</TabsContent>
  <TabsContent value="tab2">Content 2</TabsContent>
</Tabs>
