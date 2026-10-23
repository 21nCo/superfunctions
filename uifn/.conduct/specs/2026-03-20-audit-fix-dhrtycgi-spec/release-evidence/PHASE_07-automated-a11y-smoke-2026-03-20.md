# PHASE_07 Automated A11y Smoke Results

- Timestamp (UTC): 2026-03-20T17:39:30Z
- Spec: 2026-03-20-audit-fix-dhrtycgi-spec

## React

```bash
cd /Users/serro/Documents/dev/n/superfunctions/uifn/react && npm test -- --run src/accordion.a11y.test.tsx
```

```text

> @uifn/react@0.0.1 test
> vitest --run src/accordion.a11y.test.tsx


 RUN  v1.6.1 /Users/serro/Documents/dev/n/superfunctions/uifn/react

 ✓ src/accordion.a11y.test.tsx  (4 tests) 122ms

 Test Files  1 passed (1)
      Tests  4 passed (4)
   Start at  23:09:30
   Duration  1.16s (transform 76ms, setup 119ms, collect 266ms, tests 122ms, environment 366ms, prepare 80ms)

```

## Svelte

```bash
cd /Users/serro/Documents/dev/n/superfunctions/uifn/svelte && npm test -- --run src/accessibility.a11y.test.ts
```

```text

> @uifn/svelte@0.0.1 test
> vitest --run src/accessibility.a11y.test.ts


 RUN  v1.6.1 /Users/serro/Documents/dev/n/superfunctions/uifn/svelte

 ✓ src/accessibility.a11y.test.ts  (4 tests) 165ms

 Test Files  1 passed (1)
      Tests  4 passed (4)
   Start at  23:09:32
   Duration  1.05s (transform 307ms, setup 277ms, collect 273ms, tests 165ms, environment 188ms, prepare 39ms)

```
