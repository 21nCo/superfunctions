import { render } from 'solid-js/web';
import { Tabs } from '@uifn/solid/tabs';

function App() {
  return (
    <Tabs.Root defaultValue="overview" items={['overview', 'details']}>
      <Tabs.List>
        <Tabs.Trigger value="overview">Overview</Tabs.Trigger>
        <Tabs.Trigger value="details">Details</Tabs.Trigger>
        <Tabs.Indicator />
      </Tabs.List>
      <Tabs.Content value="overview">Overview panel</Tabs.Content>
      <Tabs.Content value="details">Details panel</Tabs.Content>
    </Tabs.Root>
  );
}

render(() => <App />, document.getElementById('app')!);
