import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { axe } from 'vitest-axe';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from './accordion';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogTitle,
} from './alert-dialog';
import { Checkbox } from './checkbox';
import { Combobox, ComboboxContent, ComboboxInput, ComboboxItem } from './combobox';
import { Dialog, DialogContent, DialogPortal, DialogTitle, DialogTrigger } from './dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './dropdown-menu';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select';
import {
  Toast,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from './toast';

const AccordionExample = () => (
  <Accordion type="single" collapsible>
    <AccordionItem value="item-1">
      <AccordionTrigger>Section 1</AccordionTrigger>
      <AccordionContent>Yes.</AccordionContent>
    </AccordionItem>
  </Accordion>
);

describe('Accessibility smoke', () => {
  it('collection family smoke has no axe violations', async () => {
    const { container } = render(<AccordionExample />);
    const results = await axe(container);
    expect(results.violations).toHaveLength(0);
  });

  it('form family smoke has no axe violations', async () => {
    const { container } = render(<Checkbox aria-label="Accept terms" defaultChecked={false} />);
    const results = await axe(container);
    expect(results.violations).toHaveLength(0);
  });

  it('popup family smoke has no axe violations', async () => {
    render(
      <Dialog>
        <DialogTrigger>Open Dialog</DialogTrigger>
        <DialogPortal>
          <DialogContent>
            <DialogTitle>Dialog title</DialogTitle>
            <p>Dialog body</p>
          </DialogContent>
        </DialogPortal>
      </Dialog>
    );

    fireEvent.click(screen.getByText('Open Dialog'));
    const results = await axe(document.body);
    expect(results.violations).toHaveLength(0);
  });

  it('alert-dialog smoke has no axe violations', async () => {
    const { container } = render(
      <AlertDialog defaultOpen>
        <AlertDialogPortal>
          <AlertDialogOverlay />
          <AlertDialogContent>
            <AlertDialogTitle>Delete item</AlertDialogTitle>
            <AlertDialogDescription>Deletion is permanent.</AlertDialogDescription>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction>Confirm</AlertDialogAction>
          </AlertDialogContent>
        </AlertDialogPortal>
      </AlertDialog>
    );

    const results = await axe(container);
    expect(results.violations).toHaveLength(0);
  });

  it('menu family smoke has no axe violations', async () => {
    const { container } = render(
      <DropdownMenu defaultOpen>
        <DropdownMenuTrigger>Open Menu</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Item</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );

    const results = await axe(container);
    expect(results.violations).toHaveLength(0);
  });

  it('select family smoke has no axe violations', async () => {
    const { container } = render(
      <Select>
        <SelectTrigger aria-label="Select fruit">
          <SelectValue placeholder="Select fruit" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="apple">Apple</SelectItem>
          <SelectItem value="banana">Banana</SelectItem>
        </SelectContent>
      </Select>
    );

    const results = await axe(container);
    expect(results.violations).toHaveLength(0);
  });

  it('combobox family smoke has no axe violations', async () => {
    const { container } = render(
      <Combobox defaultOpen>
        <ComboboxInput aria-label="Search fruit" />
        <ComboboxContent>
          <ComboboxItem value="apple">Apple</ComboboxItem>
          <ComboboxItem value="banana">Banana</ComboboxItem>
        </ComboboxContent>
      </Combobox>
    );

    const results = await axe(container);
    expect(results.violations).toHaveLength(0);
  });

  it('toast family smoke has no axe violations', async () => {
    render(
      <ToastProvider>
        <ToastViewport />
        <Toast>
          <ToastTitle>Saved</ToastTitle>
          <ToastDescription>Changes were saved.</ToastDescription>
        </Toast>
      </ToastProvider>
    );

    const results = await axe(document.body);
    expect(results.violations).toHaveLength(0);
  });
});
