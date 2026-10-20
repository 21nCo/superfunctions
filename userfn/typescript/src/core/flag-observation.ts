import { canonicalJson } from '../utils/json';
import type { FlagValue, UserIdentity } from '../types';
import type { FlagEvaluation } from './flags';

/** Stable, immutable selection for one observation and one client revision. */
export type FlagSnapshot = Readonly<FlagEvaluation & { key: string }>;
export interface FlagObservation {
  getSnapshot(): FlagSnapshot;
  subscribe(listener: () => void): () => void;
  /** At most one exposure per snapshot; accepts only snapshots created by this observation. */
  track(snapshot: FlagSnapshot): void;
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export function createFlagObservation(key: string, fallback: FlagValue, source: {
  revision(): number;
  subscribe(listener: () => void): () => void;
  evaluate(fallback: FlagValue): { result: FlagEvaluation; user: UserIdentity | null; token?: unknown };
  capture(result: FlagEvaluation, user: UserIdentity | null, token?: unknown): void;
}): FlagObservation {
  if (typeof key !== 'string' || !key) throw new TypeError('Flag key must be a non-empty string');
  const defaultValue: FlagValue = freeze(JSON.parse(canonicalJson(fallback)));
  let revision = -1;
  let snapshot: FlagSnapshot;
  const identities = new WeakMap<FlagSnapshot, { user: UserIdentity | null; token?: unknown }>();
  const tracked = new WeakSet<FlagSnapshot>();
  return {
    getSnapshot() {
      const nextRevision = source.revision();
      if (nextRevision !== revision) {
        const { result, user, token } = source.evaluate(defaultValue);
        snapshot = freeze({ ...result, key });
        identities.set(snapshot, { user, token });
        revision = nextRevision;
      }
      return snapshot;
    },
    subscribe: source.subscribe,
    track(selection) {
      if (!identities.has(selection)) throw new TypeError('Snapshot belongs to a different flag observation');
      if (tracked.has(selection)) return;
      tracked.add(selection);
      const identity = identities.get(selection)!;
      source.capture(selection, identity.user, identity.token);
    },
  };
}
