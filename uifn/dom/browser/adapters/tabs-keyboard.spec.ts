import { expect, test, type Page } from '@playwright/test';
import { ADAPTER_FRAMEWORKS, mountAdapterScenario, unmountAdapterScenario } from './scenario';

const tabs = ['Overview', 'Security', 'Billing'] as const;

// Known adapter defects, keyed by framework. Each stays an expected failure until fixed;
// a fix turns the run red so the entry is removed in the same change.
const expectedFailures: Partial<Record<(typeof ADAPTER_FRAMEWORKS)[number], string>> = {
  solid: 'Controlled Solid Tabs rebinds DOM services on the value round-trip and drops keyboard focus: https://linear.app/21n/issue/UIF-20',
};

async function expectActiveTab(page: Page, name: (typeof tabs)[number]): Promise<void> {
  const active = page.getByRole('tab', { name });
  await expect(active).toBeFocused();
  await expect(active).toHaveAttribute('aria-selected', 'true');
  await expect(active).toHaveAttribute('tabindex', '0');
  for (const other of tabs.filter((tab) => tab !== name)) {
    await expect(page.getByRole('tab', { name: other })).toHaveAttribute('aria-selected', 'false');
    await expect(page.getByRole('tab', { name: other })).toHaveAttribute('tabindex', '-1');
  }
  await expect(page.getByRole('tabpanel')).toHaveText(`${name} panel`);
  await expect(page.locator('[data-scenario-value]')).toHaveText(name.toLowerCase());
}

for (const framework of ADAPTER_FRAMEWORKS) {
  test(`${framework} Tabs arrow keys move focus and selection with wrapping`, async ({ page }) => {
    const knownDefect = expectedFailures[framework];
    test.fail(Boolean(knownDefect), knownDefect);
    await mountAdapterScenario(page, framework, 'tabs');
    await expect(page.getByRole('tablist', { name: 'Account sections' })).toBeVisible();

    await page.getByRole('tab', { name: 'Overview' }).focus();
    await expectActiveTab(page, 'Overview');

    await page.keyboard.press('ArrowRight');
    await expectActiveTab(page, 'Security');
    await page.keyboard.press('ArrowRight');
    await expectActiveTab(page, 'Billing');
    await page.keyboard.press('ArrowRight');
    await expectActiveTab(page, 'Overview');
    await page.keyboard.press('ArrowLeft');
    await expectActiveTab(page, 'Billing');
    await page.keyboard.press('Home');
    await expectActiveTab(page, 'Overview');
    await page.keyboard.press('End');
    await expectActiveTab(page, 'Billing');

    await unmountAdapterScenario(page);
    await expect(page.getByRole('tablist')).toHaveCount(0);
  });
}

// Never expected to fail: proves each adapter fixture mounts, reacts, and unmounts cleanly,
// so an expected keyboard failure above cannot hide a broken harness.
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
