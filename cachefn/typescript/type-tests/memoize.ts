import { memoize, memoizeSync } from '../src/index.js';
const syncOriginal = memoize((value: number) => value + 1);
const asyncOriginal = memoize(async (value: number) => value + 1);
const first: Promise<number> = syncOriginal(1);
const second: Promise<number> = asyncOriginal(1);
// @ts-expect-error Asynchronous memoization never returns a bare number.
const incorrect: number = syncOriginal(1);
// @ts-expect-error Argument types are retained.
syncOriginal('one');
const syncResult: number = memoizeSync((value: number) => value + 1)(1);
void [first, second, incorrect, syncResult];

import { cacheFn } from '../src/index.js';
const syncConvenience = cacheFn.memoize((n: number) => n + 1);
const syncNumber: number = syncConvenience(1);
const promiseConvenience = cacheFn.memoize((n: number) => Promise.resolve(n + 1));
const asyncNumber: Promise<number> = promiseConvenience(1);
const storedConvenience = cacheFn.memoize((n: number) => n + 1, { storage: 'indexeddb' });
const storedNumber: Promise<number> = storedConvenience(1);
// @ts-expect-error Arguments remain checked.
syncConvenience('one');
void [syncNumber, asyncNumber, storedNumber];
