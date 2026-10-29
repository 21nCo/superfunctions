import React from 'react';
import { Tabs } from '@uifn/react';

export function TabsScenario() {
  const [value, setValue] = React.useState('overview');
  return (
    <>
      <Tabs items={['overview', 'security', 'billing']} value={value} onValueChange={setValue}>
        <Tabs.List aria-label="Account sections">
          <Tabs.Trigger value="overview">Overview</Tabs.Trigger>
          <Tabs.Trigger value="security">Security</Tabs.Trigger>
          <Tabs.Trigger value="billing">Billing</Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content value="overview">Overview panel</Tabs.Content>
        <Tabs.Content value="security">Security panel</Tabs.Content>
        <Tabs.Content value="billing">Billing panel</Tabs.Content>
      </Tabs>
      <output data-scenario-value>{value}</output>
    </>
  );
}
