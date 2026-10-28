import { expect, test, type Page } from '@playwright/test';
import { ADAPTER_FRAMEWORKS, mountAdapterScenario, unmountAdapterScenario, type AdapterFramework } from './scenario';

const tabs = ['Overview', 'Security', 'Billing'] as const;
type TabName = (typeof tabs)[number];

// Arrow keys wrap; Home and End jump to the ends.
const keySequence: ReadonlyArray<readonly [key: string, next: TabName]> = [
  ['ArrowRight', 'Security'],
  ['ArrowRight', 'Billing'],
  ['ArrowRight', 'Overview'],
  ['ArrowLeft', 'Billing'],
  ['Home', 'Overview'],
  ['End', 'Billing'],
];

// Known focus-retention defects, keyed by framework. Each stays an expected failure until fixed;
// a fix turns the run red so the entry is removed in the same change.
const focusRetentionDefects: Partial<Record<AdapterFramework, string>> = {
  solid: 'Controlled Solid Tabs rebinds DOM services on the value round-trip and drops keyboard focus: https://linear.app/21n/issue/UIF-20',
};

async function expectSelectedTab(page: Page, name: TabName): Promise<void> {
  await expect(page.getByRole('tab', { name })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tab', { name })).toHaveAttribute('tabindex', '0');
  for (const other of tabs.filter((tab) => tab !== name)) {
    await expect(page.getByRole('tab', { name: other })).toHaveAttribute('aria-selected', 'false');
    await expect(page.getByRole('tab', { name: other })).toHaveAttribute('tabindex', '-1');
  }
  await expect(page.getByRole('tabpanel')).toHaveText(`${name} panel`);
  await expect(page.locator('[data-scenario-value]')).toHaveText(name.toLowerCase());
}

// Never expected to fail. Each key press starts from the selected tab, so this proves the
// selection, roving tabindex, panel, and bound value for every adapter, independent of
// whether focus survives the update (the next test checks that).
for (const framework of ADAPTER_FRAMEWORKS) {
  test(`${framework} Tabs arrow, Home, and End keys move selection with wrapping`, async ({ page }) => {
    await mountAdapterScenario(page, framework, 'tabs');
    await expect(page.getByRole('tablist', { name: 'Account sections' })).toBeVisible();
    await expectSelectedTab(page, 'Overview');

    let selected: TabName = 'Overview';
    for (const [key, next] of keySequence) {
      await page.getByRole('tab', { name: selected }).focus();
      await page.keyboard.press(key);
      await expectSelectedTab(page, next);
      selected = next;
    }

    await unmountAdapterScenario(page);
    await expect(page.getByRole('tablist')).toHaveCount(0);
  });
}

// Focus must follow the selection through the whole sequence without being restored.
for (const framework of ADAPTER_FRAMEWORKS) {
  test(`${framework} Tabs keyboard navigation keeps focus on the selected tab`, async ({ page }) => {
    const knownDefect = focusRetentionDefects[framework];
    test.fail(Boolean(knownDefect), knownDefect);
    await mountAdapterScenario(page, framework, 'tabs');

    await page.getByRole('tab', { name: 'Overview' }).focus();
    await expect(page.getByRole('tab', { name: 'Overview' })).toBeFocused();
    for (const [key, next] of keySequence) {
      await page.keyboard.press(key);
      await expect(page.getByRole('tab', { name: next })).toBeFocused();
      await expectSelectedTab(page, next);
    }

    await unmountAdapterScenario(page);
  });
}

// Never expected to fail: proves each adapter fixture mounts, reacts, and unmounts cleanly,
// so an expected failure above cannot hide a broken harness.
for (const framework of ADAPTER_FRAMEWORKS) {
  test(`${framework} Tabs mounts, selects by pointer, and unmounts cleanly`, async ({ page }) => {
    await mountAdapterScenario(page, framework, 'tabs');
    await expect(page.getByRole('tab')).toHaveCount(3);
    await expect(page.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');

    await page.getByRole('tab', { name: 'Billing' }).click();
    await expect(page.getByRole('tab', { name: 'Billing' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tabpanel')).toHaveText('Billing panel');
    await expect(page.locator('[data-scenario-value]')).toHaveText('billing');

    await unmountAdapterScenario(page);
    await expect(page.getByRole('tablist')).toHaveCount(0);
  });
}
