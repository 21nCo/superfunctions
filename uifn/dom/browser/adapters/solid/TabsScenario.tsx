import { createSignal } from 'solid-js';
import { Tabs } from '@uifn/solid';

export function TabsScenario() {
  const [value, setValue] = createSignal('overview');
  return (
    <>
      <Tabs.Root items={['overview', 'security', 'billing']} value={value()} onValueChange={setValue}>
        <Tabs.List aria-label="Account sections">
          <Tabs.Trigger value="overview">Overview</Tabs.Trigger>
          <Tabs.Trigger value="security">Security</Tabs.Trigger>
          <Tabs.Trigger value="billing">Billing</Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content value="overview">Overview panel</Tabs.Content>
        <Tabs.Content value="security">Security panel</Tabs.Content>
        <Tabs.Content value="billing">Billing panel</Tabs.Content>
      </Tabs.Root>
      <output data-scenario-value>{value()}</output>
    </>
  );
}
