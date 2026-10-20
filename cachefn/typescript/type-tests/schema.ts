import { CacheFn, cacheFn, type ExtractValueType, type SchemaCache } from '../src/index.js';
type User = { id: string; name: string };
type Post = { title: string };
type Schema = { 'user:*': User; 'post:*': Post; 'config': boolean; 'tenant:*:session:*': { token: string } };
const cache: SchemaCache<Schema> = cacheFn<Schema>({ name: 'schema' });
const user: Promise<User | undefined> = cache.get('user:123');
const config: Promise<boolean | undefined> = cache.get('config');
cache.set('user:123', { id: '123', name: 'Alice' });
cache.set('tenant:a:session:b', { token: 'token' });
cache.setMany([{ key: 'user:123', value: { id: '123', name: 'Alice' } }, { key: 'config', value: true }]);
const values: Promise<readonly [User | undefined, Post | undefined]> = cache.getMany(['user:123', 'post:1'] as const);
const fetched: Promise<User> = cache.getOrFetch('user:123', async () => ({ id: '123', name: 'Alice' }));
// @ts-expect-error Unknown keys are outside the schema.
cache.get('unknown');
// @ts-expect-error The colon delimiter is part of the pattern.
cache.get('username');
// @ts-expect-error Values must match the selected key, not another schema entry.
cache.set('user:123', { title: 'not a user' });
// @ts-expect-error Literal keys do not match arbitrary suffixes.
cache.set('config:extra', true);
// @ts-expect-error Batch entries retain key/value correlation.
cache.setMany([{ key: 'user:123', value: { title: 'not a user' } }]);
// @ts-expect-error Fetchers must return the selected key's value type.
cache.getOrFetch('user:123', async () => ({ title: 'not a user' }));
// @ts-expect-error Batch reads reject unknown keys.
cache.getMany(['user:123', 'unknown']);
// @ts-expect-error Delete operations also require a known pattern.
cache.delete('unknown');
const legacy = new CacheFn<number>({ name: 'legacy' });
legacy.set('arbitrary', 42);
const legacyValue: Promise<number | undefined> = legacy.get('anything');
const untyped = cacheFn({ name: 'untyped' });
untyped.set('anything', { arbitrary: true });
const extracted: ExtractValueType<Schema, 'user:123'> = { id: '123', name: 'Alice' };
void [user, config, values, fetched, legacyValue, extracted];

const overlapping = cacheFn<{ '*': { any: true }; 'exact': boolean }>({ name: 'overlap' });
overlapping.set('exact', true);
// @ts-expect-error Exact entries take precedence over broad wildcard entries.
overlapping.setMany([{ key: 'exact', value: { any: true } }]);

const offlineFetched: Promise<User> = cache.getOrFetch('user:123', { fetcher: async () => ({ id: '123', name: 'Alice' }), offlineFallback: () => ({ id: '123', name: 'Offline' }) });
cache.queueUpdate('user:123', { id: '123', name: 'Alice' }, { sync: async ({ value }) => { const user: User = value; void user; } });
// @ts-expect-error Offline fallback must match the selected schema key.
cache.getOrFetch('user:123', { fetcher: async () => ({ id: '123', name: 'Alice' }), offlineFallback: () => false });
// @ts-expect-error Queued values retain schema key/value correlation.
cache.queueUpdate('user:123', { title: 'not a user' });
void offlineFetched;

const releasedFetcher: boolean = cache.unregisterFetcher('user:123');
// @ts-expect-error Registration cleanup requires a known schema key.
cache.unregisterFetcher('unknown');
void releasedFetcher;
