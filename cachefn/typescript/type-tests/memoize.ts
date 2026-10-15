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
