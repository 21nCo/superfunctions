const DEFAULT_NAMESPACE = 'uifn';
const DEFAULT_TOKEN = 'id';
const TOKEN_SANITIZER = /[^a-z0-9-]+/g;
const REPEATED_DASHES = /-+/g;

export interface IdFactoryOptions {
  namespace?: string;
}

export interface IdFactory {
  next: (token?: string) => string;
  reset: (token?: string) => void;
  snapshot: () => Record<string, number>;
}

function normalizeToken(token: string): string {
  return token
    .trim()
    .toLowerCase()
    .replace(TOKEN_SANITIZER, '-')
    .replace(REPEATED_DASHES, '-')
    .replace(/^-|-$/g, '');
}

function createPrefix(namespace: string, token: string): string {
  if (token === DEFAULT_TOKEN || token === namespace) {
    return namespace;
  }

  if (token.startsWith(`${namespace}-`)) {
    return token;
  }

  return `${namespace}-${token}`;
}

export function createIdFactory(options: IdFactoryOptions = {}): IdFactory {
  const namespace = normalizeToken(options.namespace ?? DEFAULT_NAMESPACE) || DEFAULT_NAMESPACE;
  const counters = new Map<string, number>();

  return {
    next(token = DEFAULT_TOKEN) {
      const normalizedToken = normalizeToken(token) || DEFAULT_TOKEN;
      const prefix = createPrefix(namespace, normalizedToken);
      const nextCount = (counters.get(prefix) ?? 0) + 1;
      counters.set(prefix, nextCount);
      return `${prefix}-${nextCount}`;
    },
    reset(token?: string) {
      if (!token) {
        counters.clear();
        return;
      }

      const normalizedToken = normalizeToken(token) || DEFAULT_TOKEN;
      counters.delete(createPrefix(namespace, normalizedToken));
    },
    snapshot() {
      return Object.fromEntries(counters.entries());
    },
  };
}

export const createIdScope = createIdFactory;

const globalIdFactory = createIdFactory();

export function generateId(token = DEFAULT_TOKEN): string {
  return globalIdFactory.next(token);
}

export function resetIdCounters(token?: string): void {
  globalIdFactory.reset(token);
}

export function getIdCounterSnapshot(): Record<string, number> {
  return globalIdFactory.snapshot();
}
