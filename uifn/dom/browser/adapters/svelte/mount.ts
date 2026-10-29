import { mount, unmount, type Component } from 'svelte';
import type { AdapterScenarioModule } from '../scenario';
import TabsScenario from './TabsScenario.svelte';

const scenarios: Record<string, Component> = { tabs: TabsScenario };

export const mountScenario: AdapterScenarioModule['mountScenario'] = (scenario, target) => {
  const component = scenarios[scenario];
  if (!component) throw new Error(`svelte has no "${scenario}" scenario`);
  const instance = mount(component, { target });
  return () => { void unmount(instance); };
};
