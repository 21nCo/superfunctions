# Phase goal

Complete the TypeScript web retrieval surface, including provider support, metadata batching, and custom scraping.

## In scope / Out of scope

- **In scope**:
  - `getPage()`
  - `getMultipleMetadata()`
  - `scrape()`
  - Firecrawl and Jina providers
  - capability-aware fallback for web operations
- **Out of scope**:
  - image download transforms
  - geo provider completion
  - Python parity

## Deliverables

- `browsefn/typescript/src/web/scraper.ts`
- `browsefn/typescript/src/web/providers/cheerio.ts`
- `browsefn/typescript/src/web/providers/puppeteer.ts`
- `browsefn/typescript/src/web/providers/playwright.ts`
- `browsefn/typescript/src/web/providers/firecrawl.ts`
- `browsefn/typescript/src/web/providers/jina.ts`
- `browsefn/typescript/src/core/types.ts`
- `browsefn/typescript/tests/web-scraper.test.ts`
- `browsefn/typescript/tests/web-providers.test.ts`

## Requirements covered

- WEB-001
- WEB-002
- WEB-003
- ERR-001

## Implementation tasks

1. Add `includeLinks` and `includeImages` to the canonical page options and enforce capability checks.
2. Implement Firecrawl and Jina providers behind the canonical web-provider contract.
3. Make metadata batching preserve input order and per-item failures.
4. Implement custom scraping for script-capable providers and reject unsupported providers deterministically.
5. Add focused tests for provider capability fallback, metadata order, and custom scrape behavior.

## Verification steps

1. Run `npm --prefix browsefn/typescript run test -- --run web-scraper web-providers`.
Expected: web tests pass.
2. Run `npm --prefix browsefn/typescript run typecheck`.
Expected: typecheck still exits `0`.

## Stop condition

Report the web provider matrix implemented, the custom scrape-supported providers, and the batch metadata ordering guarantee.
