import fs from 'node:fs';
import path from 'node:path';
import { compile } from 'svelte/compiler';
import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { UIFnError } from '@uifn/core/errors';
import DialogTrigger from './DialogTrigger.svelte';
import ControlledAccordionTest from './testing/ControlledAccordionTest.svelte';
import ControlledDialogTest from './testing/ControlledDialogTest.svelte';
import DialogIdPairTest from './testing/DialogIdPairTest.svelte';
import SelectIdPairTest from './testing/SelectIdPairTest.svelte';
import ComboboxIdPairTest from './testing/ComboboxIdPairTest.svelte';
import TabsKeyboardTest from './testing/TabsKeyboardTest.svelte';

describe('Svelte controlled reactivity', () => {
  it('reflects controlled Accordion value updates after mount', async () => {
    const view = render(ControlledAccordionTest, { value: 'item-1' });

    expect(screen.getByText('Content 1')).toBeVisible();
    expect(screen.getByText('Content 2')).not.toBeVisible();

    await view.rerender({ value: 'item-2' });

    expect(screen.getByText('Content 1')).not.toBeVisible();
    expect(screen.getByText('Content 2')).toBeVisible();
  });

  it('reflects controlled Dialog open updates after mount', async () => {
    const view = render(ControlledDialogTest, { open: false });

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await view.rerender({ open: true });

    expect(screen.getByRole('dialog')).toBeVisible();
    expect(screen.getByText('Controlled Dialog')).toBeVisible();

    await view.rerender({ open: false });

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('keeps dialog instance ids unique across multiple mounts', () => {
    render(DialogIdPairTest);

    const triggers = screen.getAllByRole('button', { name: /open .* dialog/i });
    const dialogs = screen.getAllByRole('dialog');

    expect(new Set(triggers.map((trigger) => trigger.getAttribute('aria-controls'))).size).toBe(2);
    expect(new Set(dialogs.map((dialog) => dialog.id)).size).toBe(2);
  });

  it('keeps select content ids unique across multiple instances', async () => {
    render(SelectIdPairTest);

    const triggers = screen.getAllByRole('combobox');
    await fireEvent.click(triggers[0]!);
    await fireEvent.click(triggers[1]!);

    const controls = triggers.map((trigger) => trigger.getAttribute('aria-controls'));
    const listboxes = screen.getAllByRole('listbox');

    expect(controls.every(Boolean)).toBe(true);
    expect(new Set(controls).size).toBe(2);
    expect(new Set(listboxes.map((listbox) => listbox.id)).size).toBe(2);
  });

  it('keeps combobox content ids unique across multiple instances', async () => {
    render(ComboboxIdPairTest);

    const inputs = screen.getAllByRole('combobox');
    await fireEvent.input(inputs[0]!, { target: { value: 'a' } });
    await fireEvent.input(inputs[1]!, { target: { value: 'b' } });

    const controls = inputs.map((input) => input.getAttribute('aria-controls'));
    const listboxes = screen.getAllByRole('listbox');

    expect(controls.every(Boolean)).toBe(true);
    expect(new Set(controls).size).toBe(2);
    expect(new Set(listboxes.map((listbox) => listbox.id)).size).toBe(2);
  });

  it('throws the canonical context error for missing providers', () => {
    let error: unknown;

    try {
      render(DialogTrigger);
    } catch (thrown) {
      error = thrown;
    }

    expect(error).toBeInstanceOf(UIFnError);
    expect((error as UIFnError).code).toBe('UIFN_ERR_CONTEXT_MISSING');
    expect((error as UIFnError).package).toBe('@uifn/svelte');
  });

  it('supports Arrow, Home, and End keyboard navigation for Tabs', async () => {
    render(TabsKeyboardTest);

    const tab1 = screen.getByRole('tab', { name: 'Tab 1' });
    const tab2 = screen.getByRole('tab', { name: 'Tab 2' });
    const tab3 = screen.getByRole('tab', { name: 'Tab 3' });

    tab1.focus();
    await fireEvent.keyDown(tab1, { key: 'ArrowRight' });
    expect(tab2).toHaveFocus();
    expect(tab2).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Content 2')).toBeVisible();

    await fireEvent.keyDown(tab2, { key: 'End' });
    expect(tab3).toHaveFocus();
    expect(tab3).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Content 3')).toBeVisible();

    await fireEvent.keyDown(tab3, { key: 'Home' });
    expect(tab1).toHaveFocus();
    expect(tab1).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Content 1')).toBeVisible();
  });

  it('compiles the published Svelte sources without state snapshot warnings', () => {
    const sourceDir = path.resolve(process.cwd(), 'src');
    const files = fs.readdirSync(sourceDir).filter((file) => file.endsWith('.svelte'));
    const warnings = files.flatMap((file) => {
      const source = fs.readFileSync(path.join(sourceDir, file), 'utf8');
      return compile(source, { filename: file, generate: 'dom' }).warnings
        .filter((warning) => warning.code === 'state_referenced_locally')
        .map((warning) => `${file}:${warning.start?.line ?? 0}:${warning.start?.column ?? 0}`);
    });

    expect(warnings).toEqual([]);
  });
});
