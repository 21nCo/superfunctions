import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { axe } from 'vitest-axe';
import { Button } from '../react/accordion.test'; // Example import or just use a generic button
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from '../react/accordion';

// We need a proper example to test.
const AccordionExample = () => (
  <Accordion type="single" collapsible>
    <AccordionItem value="item-1">
      <AccordionTrigger>Is it accessible?</AccordionTrigger>
      <AccordionContent>Yes.</AccordionContent>
    </AccordionItem>
  </Accordion>
);

describe.skip('Accessibility', () => {
  it('Accordion should have no accessibility violations', async () => {
    const { container } = render(<AccordionExample />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
