import type { AsrAdapter } from 'recfn';

export interface AsrRegistry {
  register(adapter: AsrAdapter): void;
  get(name: string): AsrAdapter | undefined;
  has(name: string): boolean;
  names(): string[];
}

export function createAsrRegistry(): AsrRegistry {
  const adapters = new Map<string, AsrAdapter>();

  return {
    register(adapter: AsrAdapter): void {
      adapters.set(adapter.name, adapter);
    },

    get(name: string): AsrAdapter | undefined {
      return adapters.get(name);
    },

    has(name: string): boolean {
      return adapters.has(name);
    },

    names(): string[] {
      return [...adapters.keys()];
    },
  };
}
