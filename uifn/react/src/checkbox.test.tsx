import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { Checkbox, CheckboxIndicator } from './checkbox';

describe('Checkbox', () => {
  it('toggles state', () => {
    render(
      <Checkbox defaultChecked={false}>
        <CheckboxIndicator>✓</CheckboxIndicator>
      </Checkbox>
    );

    const checkbox = screen.getByRole('checkbox');
    expect(checkbox).toHaveAttribute('data-state', 'unchecked');
    expect(screen.queryByText('✓')).not.toBeInTheDocument();

    fireEvent.click(checkbox);
    expect(checkbox).toHaveAttribute('data-state', 'checked');
    expect(screen.getByText('✓')).toBeVisible();

    fireEvent.click(checkbox);
    expect(checkbox).toHaveAttribute('data-state', 'unchecked');
  });

  it('supports indeterminate state', () => {
    render(
      <Checkbox checked="indeterminate">
        <CheckboxIndicator>-</CheckboxIndicator>
      </Checkbox>
    );
    
    const checkbox = screen.getByRole('checkbox');
    expect(checkbox).toHaveAttribute('aria-checked', 'mixed');
    expect(checkbox).toHaveAttribute('data-state', 'indeterminate');
    expect(screen.getByText('-')).toBeVisible();
  });
});
