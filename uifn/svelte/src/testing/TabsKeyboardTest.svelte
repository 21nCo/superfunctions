<script lang="ts">
  import Tabs from '../Tabs.svelte';
  import TabsList from '../TabsList.svelte';
  import TabsTrigger from '../TabsTrigger.svelte';
  import TabsContent from '../TabsContent.svelte';
</script>

<Tabs defaultValue="tab-1">
  <TabsList>
    <TabsTrigger value="tab-1">Tab 1</TabsTrigger>
    <TabsTrigger value="tab-2">Tab 2</TabsTrigger>
    <TabsTrigger value="tab-3">Tab 3</TabsTrigger>
  </TabsList>
  <TabsContent value="tab-1">Content 1</TabsContent>
  <TabsContent value="tab-2">Content 2</TabsContent>
  <TabsContent value="tab-3">Content 3</TabsContent>
</Tabs>
