import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/svelte';
import { axe } from 'vitest-axe';
import AccordionTest from './testing/AccordionTest.svelte';
import AlertDialogTest from './testing/AlertDialogTest.svelte';
import ComboboxTest from './testing/ComboboxTest.svelte';
import DialogTest from './testing/DialogTest.svelte';
import DropdownMenuTest from './testing/DropdownMenuTest.svelte';
import SelectTest from './testing/SelectTest.svelte';
import ToastTest from './testing/ToastTest.svelte';
import Checkbox from './Checkbox.svelte';

describe('Svelte accessibility smoke', () => {
  it('collection family smoke has no axe violations', async () => {
    const { container } = render(AccordionTest, {
      type: 'single',
      defaultValue: 'item-1',
    });

    const results = await axe(container);
    expect(results.violations).toHaveLength(0);
  });

  it('form family smoke has no axe violations', async () => {
    const { container } = render(Checkbox, {
      'aria-label': 'Accept terms',
      defaultChecked: false,
    });

    const results = await axe(container);
    expect(results.violations).toHaveLength(0);
  });

  it('popup family smoke has no axe violations', async () => {
    render(DialogTest, { defaultOpen: true });

    const results = await axe(document.body);
    expect(results.violations).toHaveLength(0);
  });

  it('alert-dialog smoke has no axe violations', async () => {
    render(AlertDialogTest, { defaultOpen: true });

    const results = await axe(document.body);
    expect(results.violations).toHaveLength(0);
  });

  it('menu family smoke has no axe violations', async () => {
    const { container } = render(DropdownMenuTest, { defaultOpen: true });

    const results = await axe(container);
    expect(results.violations).toHaveLength(0);
  });

  it('select family smoke has no axe violations', async () => {
    const { container } = render(SelectTest, { triggerLabel: 'Select fruit' });

    const results = await axe(container);
    expect(results.violations).toHaveLength(0);
  });

  it('combobox family smoke has no axe violations', async () => {
    const { container } = render(ComboboxTest, { inputLabel: 'Search fruit' });

    const results = await axe(container);
    expect(results.violations).toHaveLength(0);
  });

  it('toast family smoke has no axe violations', async () => {
    render(ToastTest, {
      defaultOpen: true,
      duration: Infinity,
      includeViewport: true,
    });

    const results = await axe(document.body);
    expect(results.violations).toHaveLength(0);
  });
});
