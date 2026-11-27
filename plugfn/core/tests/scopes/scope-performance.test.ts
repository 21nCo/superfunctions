import { describe, expect, it } from 'vitest';
import { defineScopeGrammar, SCOPE_LIMITS, type ScopeRisk } from '../../src/scopes/index.js';

/**
 * Timing tests. vitest.config.ts runs this file in its own project, after
 * every other test file has finished, so the CPU-heavy in-memory type checks
 * never run beside it.
 *
 * Only the issue's acceptance vectors (10k covered, 10k uncovered and 10k
 * classified items) keep an absolute bound: best of three under 50 ms, about
 * ten times what they take idle. Every adversarial vector is instead measured
 * against an equal-size control that is not adversarial, interleaved in the
 * same test, and must stay under {@link RATIO_LIMIT} times it: uniform machine
 * load slows both alike, while each defect these vectors guard against (a
 * hash-bucketed index, a Map keyed by code unit, a Set keyed by integer-like
 * strings, a sorted index) costs tens to hundreds of times its control.
 */
const RATIO_LIMIT = 3;

// Every timed workload holds exactly 10k requested items, the acceptance bound.
const n = 10_000;
const half = n / 2;

/** Best of three timed runs after a warm-up, so scheduler noise from parallel suites does not decide the result. */
function bestOfThree(run: () => void): number {
  run();
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 3; i++) {
    const start = performance.now();
    run();
    best = Math.min(best, performance.now() - start);
  }
  return best;
}

/**
 * Best of three interleaved timed runs of each function after a warm-up, so
 * a run and its control see the same machine load.
 */
function bestOfThreeEach(...runs: (() => void)[]): number[] {
  for (const run of runs) run();
  const best = runs.map(() => Number.POSITIVE_INFINITY);
  for (let round = 0; round < 3; round++) {
    runs.forEach((run, i) => {
      const start = performance.now();
      run();
      best[i] = Math.min(best[i]!, performance.now() - start);
    });
  }
  return best;
}

/** Asserts that `adversarial` stays under {@link RATIO_LIMIT} times `control`, measured together. */
function expectNearControl(control: () => void, adversarial: () => void): void {
  const [controlMs, adversarialMs] = bestOfThreeEach(control, adversarial);
  expect(adversarialMs, `adversarial ${adversarialMs!.toFixed(1)} ms vs control ${controlMs!.toFixed(1)} ms`).toBeLessThan(controlMs! * RATIO_LIMIT);
}

/** Deterministic shuffle. */
function shuffle<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let state = seed;
  for (let i = out.length - 1; i > 0; i--) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    const j = Math.floor((state / 2 ** 32) * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

const globGrammar = (provider: string) => defineScopeGrammar({ provider, dimensions: { paths: { kind: 'prefixGlobSet' } }, riskOf: () => 'read' });

describe('acceptance: 10k items in under 50 ms', () => {
  const big = defineScopeGrammar({
    provider: 'big',
    dimensions: { ids: { kind: 'exactSet' }, paths: { kind: 'prefixGlobSet' }, ttl: { kind: 'ttlMax' } },
    riskOf: ({ value }) => (String(value).startsWith('w') ? 'write' : 'read'),
  });
  const ids = Array.from({ length: half }, (_, i) => `id-${i}`);
  // 10k distinct envelope globs: a matcher that compares every request item
  // with every envelope pattern does 5 x 10^7 comparisons and cannot meet the bound.
  const envelopePaths = Array.from({ length: n }, (_, i) => `team-${i}/*`);
  const requestPaths = Array.from({ length: half - 1 }, (_, i) => (i % 2 ? `team-${n - 1 - 2 * i}/repo` : `team-${n - 1 - 2 * i}/sub*`));
  // 5k ids + 4,999 paths + 1 ttl = 10k items.
  const request = { ids, paths: requestPaths, ttl: 60 };
  const env = { ids: [...ids].reverse(), paths: envelopePaths, ttl: 60 };
  // 5k ids + 4,999 paths + 1 ttl = 10k items, every one outside the envelope below.
  const uncovered = { ids, paths: requestPaths, ttl: 61 };
  const writeLast = { ids: [...ids.slice(0, -1), 'w-last'], paths: requestPaths, ttl: 60 };

  it('evaluates 10k requested items against 10k envelope globs in under 50 ms', () => {
    let result: ReturnType<typeof big.isSubset> | undefined;
    const elapsed = bestOfThree(() => {
      result = big.isSubset(request, env);
    });
    expect(result).toEqual({ ok: true, violations: [], scope: expect.objectContaining({ ttl: 60 }) });
    expect(elapsed).toBeLessThan(50);
  });

  it('reports 10k uncovered items in under 50 ms', () => {
    let result: ReturnType<typeof big.isSubset> | undefined;
    const elapsed = bestOfThree(() => {
      result = big.isSubset(uncovered, { ids: [], paths: ['other/*'], ttl: 60 });
    });
    expect(result?.violations).toHaveLength(n);
    expect(elapsed).toBeLessThan(50);
  });

  it('classifies 10k items in under 50 ms', () => {
    let risk: ScopeRisk | undefined;
    const elapsed = bestOfThree(() => {
      risk = big.classifyRisk(writeLast);
    });
    expect(risk).toBe('write');
    expect(elapsed).toBeLessThan(50);
  });
});

describe(`adversarial input costs under ${RATIO_LIMIT}x an equal-size control`, () => {
  /**
   * 2^levels distinct strings, one two-character block per level, so the
   * strings form a binary tree of shared prefixes. `blocksAt` picks the two
   * blocks of each level from the 32-bit FNV-1a state the strings share so far.
   */
  function blockTreeStrings(levels: number, blocksAt: (state: number) => [string, string, number]): string[] {
    let strings = [''];
    let state = 0x811c9dc5 | 0;
    for (let level = 0; level < levels; level++) {
      const [left, right, next] = blocksAt(state);
      state = next;
      strings = strings.flatMap(prefix => [prefix + left, prefix + right]);
    }
    return strings;
  }

  const fnvStep = (hash: number, code: number) => Math.imul(hash ^ code, 0x01000193);

  /**
   * Two blocks that collide from the same FNV-1a state: the first characters
   * give equal high 16 bits, and the second characters cancel the low 16 bits.
   * Every string of the tree then shares one hash, the input shape that
   * degrades a hash-bucketed prefix index to E x R comparisons.
   */
  function fnvCollidingBlocks(state: number): [string, string, number] {
    const usable = (code: number) => code >= 0x100 && code <= 0xffff && (code < 0xd800 || code > 0xdfff);
    const firstByHighBits = new Map<number, number>();
    for (let a = 0x100; ; a++) {
      const mid = fnvStep(state, a);
      const other = firstByHighBits.get(mid >>> 16);
      if (other === undefined) {
        firstByHighBits.set(mid >>> 16, a);
        continue;
      }
      const delta = (fnvStep(state, other) ^ mid) & 0xffff;
      for (let b = 0x100; b <= 0xffff; b++) {
        if (usable(b) && usable(b ^ delta)) return [String.fromCharCode(other, b ^ delta), String.fromCharCode(a, b), fnvStep(mid, b)];
      }
    }
  }

  it('10k envelope prefixes and 10k request items that share one FNV-1a hash', () => {
    const colliding = blockTreeStrings(15, fnvCollidingBlocks);
    // The same tree shape, with fixed two-byte blocks that do not collide.
    const control = blockTreeStrings(15, state => ['Āā', 'Ăă', state]);
    const globs = globGrammar('fnv');
    const vector = (strings: string[]) => [{ paths: strings.slice(n, 2 * n) }, { paths: strings.slice(0, n).map(prefix => `${prefix}*`) }] as const;
    const [collidingRequest, collidingEnvelope] = vector(colliding);
    const [controlRequest, controlEnvelope] = vector(control);
    expect(globs.isSubset(collidingRequest, collidingEnvelope).violations).toHaveLength(n);
    expect(globs.isSubset(controlRequest, controlEnvelope).violations).toHaveLength(n);
    expect(globs.isSubset({ paths: [`${colliding[n - 1]}/repo`] }, collidingEnvelope).ok).toBe(true);
    expectNearControl(
      () => globs.isSubset(controlRequest, controlEnvelope),
      () => globs.isSubset(collidingRequest, collidingEnvelope),
    );
  });

  it('1,000 maximum-length envelope globs: time follows the item count, not a node per character', () => {
    // About 4M characters on each side. A per-character trie allocates about
    // 4M nodes here and takes seconds. Control: normalizing both sides, which
    // copies and validates the same input but builds no index.
    const filler = 'x'.repeat(SCOPE_LIMITS.maxMemberLength - 5);
    const prefixes = Array.from({ length: 1_000 }, (_, i) => `${String(i).padStart(4, '0')}${filler}`);
    const globs = globGrammar('long-globs');
    const longEnvelope = { paths: prefixes.map(prefix => `${prefix}*`) };
    const longRequest = { paths: prefixes.map(prefix => `${prefix}r`) };
    expect(globs.isSubset(longRequest, longEnvelope).ok).toBe(true);
    expect(globs.isSubset({ paths: [`${prefixes[0]!.slice(0, -1)}y`] }, longEnvelope).ok).toBe(false);
    expectNearControl(
      () => {
        globs.normalize(longRequest);
        globs.normalize(longEnvelope);
      },
      () => globs.isSubset(longRequest, longEnvelope),
    );
  });

  /**
   * The unseeded 32-bit integer hash V8 applies to small-integer Map keys
   * (ComputeUnseededHash). It is fixed, so an envelope can pick sibling code
   * units that all land in one bucket of a code-unit-keyed Map.
   */
  function v8SmiHash(key: number): number {
    let x = key >>> 0;
    x = (~x + (x << 15)) >>> 0;
    x = (x ^ (x >>> 12)) >>> 0;
    x = (x + (x << 2)) >>> 0;
    x = (x ^ (x >>> 4)) >>> 0;
    x = Math.imul(x, 2057) >>> 0;
    x = (x ^ (x >>> 16)) >>> 0;
    return x & 0x3fffffff;
  }

  it('sibling code units that collide in the runtime integer hash', () => {
    // One main-path glob plus 200 sibling globs at each of 50 depths of that
    // path (10,001 envelope items), and 10k request items that walk the whole
    // path. With siblings that share one V8 Smi hash bucket, a child index
    // keyed by the runtime's integer hash walks a 200-entry bucket chain at
    // every depth (about 40 times the control). Control: for each colliding
    // code unit the next one outside that bucket, so the trie has nearly the
    // same shape but the siblings spread over the buckets.
    const main = 0x61;
    const depth = 50;
    const buckets = 128;
    const target = v8SmiHash(main) & (buckets - 1);
    const usable = (code: number) => code !== main && code !== 0x2a && (code < 0xd800 || code > 0xdfff);
    const colliding: number[] = [];
    for (let code = 0x21; code < 0x10000 && colliding.length < 200; code++) {
      if (usable(code) && (v8SmiHash(code) & (buckets - 1)) === target) colliding.push(code);
    }
    expect(colliding).toHaveLength(200);
    const spread: number[] = [];
    for (const code of colliding) {
      let next = code + 1;
      while (!usable(next) || (v8SmiHash(next) & (buckets - 1)) === target || spread.includes(next)) next++;
      spread.push(next);
    }
    const mainPath = `${'a'.repeat(depth)}z`;
    const envelopeOf = (siblings: number[]) => {
      const paths = [`${mainPath}*`];
      for (let d = 0; d < depth; d++) {
        for (const code of siblings) paths.push(`${'a'.repeat(d)}${String.fromCharCode(code)}*`);
      }
      return { paths };
    };
    const collidingEnvelope = envelopeOf(colliding);
    const controlEnvelope = envelopeOf(spread);
    const request = { paths: Array.from({ length: n }, (_, i) => `${mainPath}${i}`) };
    const globs = globGrammar('smi-collisions');
    expect(globs.isSubset(request, collidingEnvelope).ok).toBe(true);
    expect(globs.isSubset(request, controlEnvelope).ok).toBe(true);
    expect(globs.isSubset({ paths: [`${'a'.repeat(depth)}y`] }, collidingEnvelope).ok).toBe(false);
    expectNearControl(
      () => globs.isSubset(request, controlEnvelope),
      () => globs.isSubset(request, collidingEnvelope),
    );
  });

  describe('integer-like members, which V8 hashes without its seed', () => {
    // String(i * 4096) and String(i * 65536) are array-index strings: V8
    // hashes them from their numeric value, so they share one bucket chain in
    // a Set keyed by the member itself (over 100 times the control). Control:
    // the same members with a trailing letter, which are not index strings but
    // also start with a digit, so the engine keys both alike.
    const literals = defineScopeGrammar({
      provider: 'index-strings',
      dimensions: { ids: { kind: 'exactSet' }, paths: { kind: 'prefixGlobSet' } },
      riskOf: () => 'read',
    });
    const colliding = (step: number) => Array.from({ length: n }, (_, i) => String(i * step));
    const control = (step: number) => Array.from({ length: n }, (_, i) => `${i * step}k`);

    for (const step of [4096, 65_536]) {
      it(`compares 10k exactSet members String(i * ${step})`, () => {
        const [items, plain] = [colliding(step), control(step)];
        expect(literals.isSubset({ ids: items }, { ids: items }).ok).toBe(true);
        expect(literals.isSubset({ ids: ['1'] }, { ids: items }).ok).toBe(false);
        expectNearControl(
          () => literals.isSubset({ ids: plain }, { ids: plain }),
          () => literals.isSubset({ ids: items }, { ids: items }),
        );
      });

      it(`compares 10k prefixGlobSet literals String(i * ${step})`, () => {
        const [items, plain] = [colliding(step), control(step)];
        expect(literals.isSubset({ paths: items }, { paths: items }).ok).toBe(true);
        expect(literals.isSubset({ paths: ['1'] }, { paths: items }).ok).toBe(false);
        expectNearControl(
          () => literals.isSubset({ paths: plain }, { paths: plain }),
          () => literals.isSubset({ paths: items }, { paths: items }),
        );
      });

      it(`deduplicates a request of 10k colliding members String(i * ${step})`, () => {
        // 5k distinct members, each twice.
        const items = colliding(step).map((_, i) => String((i % half) * step));
        const plain = items.map(item => `${item}k`);
        const result = literals.normalize({ ids: items });
        expect(result.ok && result.scope.ids).toHaveLength(half);
        expect(result.ok && result.scope.ids.slice(0, 2)).toEqual(['0', String(step)]);
        expectNearControl(
          () => literals.normalize({ ids: plain }),
          () => literals.normalize({ ids: items }),
        );
      });

      it(`checks 10k members against a 10k-value vocabulary of String(i * ${step})`, () => {
        const [items, plain] = [colliding(step), control(step)];
        const vocabulary = (values: string[]) =>
          defineScopeGrammar({ provider: 'index-vocabulary', dimensions: { ids: { kind: 'exactSet', values } }, riskOf: () => 'read' });
        const [collidingGrammar, controlGrammar] = [vocabulary(items), vocabulary(plain)];
        expect(collidingGrammar.isSubset({ ids: items }, { ids: items }).ok).toBe(true);
        expect(collidingGrammar.normalize({ ids: ['1'] })).toMatchObject({ ok: false, violations: [expect.objectContaining({ code: 'malformed', item: '1' })] });
        expectNearControl(
          () => controlGrammar.isSubset({ ids: plain }, { ids: plain }),
          () => collidingGrammar.isSubset({ ids: items }, { ids: items }),
        );
      });
    }
  });

  /**
   * 10k shuffled envelope globs and 10k request items that all share a
   * `shared`-unit prefix. A comparison sort of the envelope prefixes walks the
   * shared prefix in each of its O(E log E) comparisons. Control: the same
   * members with the index first and the shared run after it, so they differ
   * within a few code units.
   */
  function sharedPrefixVector(shared: number) {
    const run = 'p'.repeat(shared);
    const indexes = Array.from({ length: n }, (_, i) => i);
    const globs = globGrammar(`shared-prefix-${shared}`);
    const envelopeOf = (member: (i: number) => string) => ({ paths: shuffle(indexes, 0x5eed).map(i => `${member(i)}/*`) });
    const requestOf = (member: (i: number) => string) => ({ paths: shuffle(indexes, 0xbeef).map(i => `${member(i)}/repo`) });
    const sharedMember = (i: number) => `${run}${i}`;
    const controlMember = (i: number) => `${i}${run}`;
    const [sharedEnvelope, sharedRequest] = [envelopeOf(sharedMember), requestOf(sharedMember)];
    const [controlEnvelope, controlRequest] = [envelopeOf(controlMember), requestOf(controlMember)];
    expect(globs.isSubset(sharedRequest, sharedEnvelope).ok).toBe(true);
    expect(globs.isSubset(controlRequest, controlEnvelope).ok).toBe(true);
    expect(globs.isSubset({ paths: [`${run}${n}/repo`, `${run.slice(1)}q`] }, sharedEnvelope).violations).toHaveLength(2);
    expectNearControl(
      () => globs.isSubset(controlRequest, controlEnvelope),
      () => globs.isSubset(sharedRequest, sharedEnvelope),
    );
  }

  it('10k shuffled envelope globs sharing a 64-unit prefix', () => {
    sharedPrefixVector(64);
  });

  it('10k shuffled envelope globs sharing a 2000-unit prefix', () => {
    // 20M envelope code units and 20M request code units.
    sharedPrefixVector(2000);
  });

  it('every usable first code unit as a sibling at one trie node', () => {
    // Every UTF-16 code unit a member may start with (all but control
    // characters and "*"): 65,502 siblings under the root, in shuffled order.
    // A sorted child array with insertion by splice would be quadratic here.
    // Control: normalizing both sides, which copies and validates the same
    // input but builds no index.
    const codes = Array.from({ length: 0x10000 }, (_, code) => code).filter(code => code >= 0x20 && code !== 0x7f && code !== 0x2a);
    expect(codes).toHaveLength(65_502);
    const siblings = { paths: shuffle(codes, 0x5eed).map(code => `${String.fromCharCode(code)}-x*`) };
    const picks = shuffle(codes, 0xbeef);
    const siblingRequest = { paths: Array.from({ length: n }, (_, i) => `${String.fromCharCode(picks[i % picks.length]!)}-x/${i}`) };
    const globs = globGrammar('wide-node');
    expect(globs.isSubset(siblingRequest, siblings).ok).toBe(true);
    expect(globs.isSubset({ paths: ['a-y'] }, siblings).ok).toBe(false);
    expectNearControl(
      () => {
        globs.normalize(siblingRequest);
        globs.normalize(siblings);
      },
      () => globs.isSubset(siblingRequest, siblings),
    );
  });
});
