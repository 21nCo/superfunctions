import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { Switch, SwitchThumb } from './switch';

describe('Switch', () => {
  it('toggles state', () => {
    render(
      <Switch>
        <SwitchThumb />
      </Switch>
    );

    const switchBtn = screen.getByRole('switch');
    expect(switchBtn).toHaveAttribute('data-state', 'unchecked');

    fireEvent.click(switchBtn);
    expect(switchBtn).toHaveAttribute('data-state', 'checked');
    expect(switchBtn).toHaveAttribute('aria-checked', 'true');
  });
});
