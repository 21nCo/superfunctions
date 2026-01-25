import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { RadioGroup, RadioGroupItem, RadioGroupIndicator } from './radio-group';

describe('RadioGroup', () => {
  it('selects items', () => {
    render(
      <RadioGroup defaultValue="1">
        <RadioGroupItem value="1">
            Item 1 <RadioGroupIndicator />
        </RadioGroupItem>
        <RadioGroupItem value="2">
            Item 2 <RadioGroupIndicator />
        </RadioGroupItem>
      </RadioGroup>
    );

    const item1 = screen.getAllByRole('radio')[0];
    const item2 = screen.getAllByRole('radio')[1];

    expect(item1).toHaveAttribute('data-state', 'checked');
    expect(item2).toHaveAttribute('data-state', 'unchecked');

    fireEvent.click(item2);

    expect(item1).toHaveAttribute('data-state', 'unchecked');
    expect(item2).toHaveAttribute('data-state', 'checked');
  });
});
