import { createIdFactory } from '@uifn/core/utils';

interface SveltePublicIdInput {
  prefix?: string;
  slot?: string;
}

const svelteIdFactory = createIdFactory();

export function createSveltePublicId(
  id: string | null | undefined,
  input: SveltePublicIdInput
): string {
  if (id) {
    return id;
  }

  const prefix = input.prefix ? `svelte-${input.prefix}` : 'svelte-id';
  return svelteIdFactory.next(input.slot ? `${prefix}-${input.slot}` : prefix);
}
