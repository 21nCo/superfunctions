import type { AdapterFramework, AdapterScenarioModule, AdapterScenarioStatus } from './scenario';

declare global {
  interface Window {
    __UIFN_ADAPTER_SCENARIO__?: AdapterScenarioStatus;
  }
}

const loaders: Record<AdapterFramework, () => Promise<AdapterScenarioModule>> = {
  svelte: () => import('./svelte/mount'),
  react: () => import('./react/mount'),
  solid: () => import('./solid/mount'),
};

const params = new URLSearchParams(location.search);
const framework = params.get('framework') as AdapterFramework | null;
const scenario = params.get('scenario') ?? '';
const status: AdapterScenarioStatus = { state: 'loading', framework, scenario, errors: [] };
window.__UIFN_ADAPTER_SCENARIO__ = status;

// Framework warnings and uncaught errors fail the scenario rather than passing silently.
const record = (kind: string) => (...args: unknown[]) => { status.errors.push(`${kind}: ${args.map(String).join(' ')}`); };
const originalError = console.error.bind(console);
const originalWarn = console.warn.bind(console);
console.error = (...args) => { record('console.error')(...args); originalError(...args); };
console.warn = (...args) => { record('console.warn')(...args); originalWarn(...args); };
window.addEventListener('error', (event) => record('error')(event.message));
window.addEventListener('unhandledrejection', (event) => record('unhandledrejection')(event.reason));

async function start(): Promise<void> {
  const target = document.getElementById('scenario-root');
  if (!framework || !(framework in loaders)) throw new Error(`unknown framework "${framework}"`);
  if (!target) throw new Error('missing #scenario-root');
  const module = await loaders[framework]();
  const unmount = module.mountScenario(scenario, target);
  status.unmount = () => {
    unmount();
    status.state = 'unmounted';
  };
  status.state = 'mounted';
}

// A rejection is not always an Error; keep an object's fields rather than "[object Object]".
function describeError(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message;
  if (typeof error !== 'object' || error === null) return String(error);
  try {
    return JSON.stringify(error);
  } catch {
    return Object.prototype.toString.call(error);
  }
}

start().catch((error: unknown) => {
  status.state = 'failed';
  status.errors.push(`mount: ${describeError(error)}`);
});
