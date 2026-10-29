<script lang="ts">
  import { Tabs } from '@uifn/svelte';

  let value = $state('overview');
</script>

<Tabs.Root items={['overview', 'security', 'billing']} bind:value>
  <Tabs.List aria-label="Account sections">
    <Tabs.Trigger value="overview">Overview</Tabs.Trigger>
    <Tabs.Trigger value="security">Security</Tabs.Trigger>
    <Tabs.Trigger value="billing">Billing</Tabs.Trigger>
  </Tabs.List>
  <Tabs.Content value="overview">Overview panel</Tabs.Content>
  <Tabs.Content value="security">Security panel</Tabs.Content>
  <Tabs.Content value="billing">Billing panel</Tabs.Content>
</Tabs.Root>
<output data-scenario-value>{value}</output>
