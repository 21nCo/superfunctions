import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { axe } from 'vitest-axe';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from './accordion';
import { Checkbox } from './checkbox';
import { Dialog, DialogContent, DialogPortal, DialogTitle, DialogTrigger } from './dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './dropdown-menu';

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
    const { container } = render(
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
});
