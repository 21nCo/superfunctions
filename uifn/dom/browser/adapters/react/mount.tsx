import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import type { AdapterScenarioModule } from '../scenario';
import { TabsScenario } from './TabsScenario';

const scenarios: Record<string, React.ComponentType> = { tabs: TabsScenario };

export const mountScenario: AdapterScenarioModule['mountScenario'] = (scenario, target) => {
  const Scenario = scenarios[scenario];
  if (!Scenario) throw new Error(`react has no "${scenario}" scenario`);
  const root = createRoot(target);
  flushSync(() => root.render(<React.StrictMode><Scenario /></React.StrictMode>));
  return () => root.unmount();
};
