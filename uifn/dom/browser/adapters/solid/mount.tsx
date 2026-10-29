import type { Component } from 'solid-js';
import { render } from 'solid-js/web';
import type { AdapterScenarioModule } from '../scenario';
import { TabsScenario } from './TabsScenario';

const scenarios: Record<string, Component> = { tabs: TabsScenario };

export const mountScenario: AdapterScenarioModule['mountScenario'] = (scenario, target) => {
  const Scenario = scenarios[scenario];
  if (!Scenario) throw new Error(`solid has no "${scenario}" scenario`);
  return render(() => <Scenario />, target);
};
