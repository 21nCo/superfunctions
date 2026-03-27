import { assertContext } from '@uifn/core/errors';
import { getContext } from 'svelte';

export function getRequiredContext<T>(
  key: string,
  component: string,
  message: string
): T {
  return assertContext(getContext<T | null | undefined>(key), {
    package: '@uifn/svelte',
    component,
    message,
  });
}
