import { expect, afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import * as matchers from '@testing-library/jest-dom/matchers';
import { toHaveNoViolations } from 'vitest-axe';

expect.extend(matchers);
expect.extend({ toHaveNoViolations });

afterEach(() => {
  cleanup();
});