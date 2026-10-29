import { expect, type Page } from '@playwright/test';

export const ADAPTER_FRAMEWORKS = ['svelte', 'react', 'solid'] as const;
export type AdapterFramework = (typeof ADAPTER_FRAMEWORKS)[number];

/** Served by the second web server in ../../playwright.config.ts. */
export const ADAPTER_SCENARIO_ORIGIN = 'http://127.0.0.1:4176';

/** Each framework's mount.ts implements this for every scenario name it supports. */
export interface AdapterScenarioModule {
  mountScenario(scenario: string, target: HTMLElement): () => void;
}

export interface AdapterScenarioStatus {
  state: 'loading' | 'mounted' | 'unmounted' | 'failed';
  framework: string | null;
  scenario: string;
  errors: string[];
  unmount?: () => void;
}

/** Loads one framework fixture into a fresh page and waits until it has mounted. */
export async function mountAdapterScenario(page: Page, framework: AdapterFramework, scenario: string): Promise<void> {
  const query = new URLSearchParams({ framework, scenario });
  await page.goto(`${ADAPTER_SCENARIO_ORIGIN}/index.html?${query}`);
  await page.waitForFunction(() => {
    const state = window.__UIFN_ADAPTER_SCENARIO__?.state;
    return state === 'mounted' || state === 'failed';
  });
  expect(await adapterScenarioErrors(page)).toEqual([]);
}

/** Unmounts the fixture and asserts no framework warning or error was recorded at any point. */
export async function unmountAdapterScenario(page: Page): Promise<void> {
  await page.evaluate(() => window.__UIFN_ADAPTER_SCENARIO__?.unmount?.());
  expect(await page.evaluate(() => window.__UIFN_ADAPTER_SCENARIO__?.state)).toBe('unmounted');
  expect(await adapterScenarioErrors(page)).toEqual([]);
}

export function adapterScenarioErrors(page: Page): Promise<string[]> {
  return page.evaluate(() => window.__UIFN_ADAPTER_SCENARIO__?.errors ?? ['scenario status missing']);
}
