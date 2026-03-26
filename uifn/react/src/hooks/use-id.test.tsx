import { render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateId } from '@uifn/core/utils/id';
import { useId } from './use-id';

vi.mock('@uifn/core/utils/id', () => ({
  generateId: vi.fn(() => 'fallback-id'),
}));

function UseIdHarness() {
  const id = useId(undefined, { prefix: 'dialog', slot: 'content' });
  return <div data-testid="target" id={id} />;
}

describe('useId', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('does not generate a fallback id when React.useId is available', () => {
    render(<UseIdHarness />);

    expect(generateId).not.toHaveBeenCalled();
    expect(screen.getByTestId('target').id).toMatch(/^uifn-dialog-content-/);
  });
});
