# Phase 15: Code Snippet Generation

## Phase Goal
Implement code snippet generation for multiple languages/libraries.

## In Scope
- `generateSnippet(operation, path, method, options)` — single endpoint
- `generateAllSnippets(spec, options)` — all endpoints
- Targets: curl, fetch, axios, python-requests, python-httpx, node-fetch, go-http, ruby-net-http, php-curl, csharp-httpclient, java-okhttp
- Auth injection (Bearer, API Key, Basic)
- Variable substitution (baseUrl, examples)

## Out of Scope
- CLI snippet command (integrated in phase 17)
- UI snippet display (later)

## Deliverables
- `apifn/snippets/src/generator.ts`
- `apifn/snippets/src/types.ts`
- `apifn/snippets/src/targets/curl.ts`
- `apifn/snippets/src/targets/fetch.ts`
- `apifn/snippets/src/targets/axios.ts`
- `apifn/snippets/src/targets/python-requests.ts`
- Additional target files
- `apifn/snippets/__tests__/snippets.test.ts`

## Requirements Covered
- SNIP-001, SNIP-002, SNIP-003, SNIP-004, SNIP-005, SNIP-006, SNIP-007

## Implementation Tasks
1. [ ] Define snippet target interface: `{ generate(op, path, method, opts): string }`
2. [ ] Implement curl target: method, URL, headers, body, auth
3. [ ] Implement fetch target: async/await, method, headers, body
4. [ ] Implement axios target
5. [ ] Implement python-requests target
6. [ ] Implement remaining targets (go-http, ruby, php, csharp, java, python-httpx, node-fetch)
7. [ ] Implement auth injection: Bearer, API Key, Basic for each target
8. [ ] Implement `generateAllSnippets()`: iterate operations, generate snippet per target
9. [ ] Write tests for TV-SNIP-001 through TV-SNIP-007
10. [ ] Export from snippets index

## Verification Steps
1. `npm run test` → snippet tests pass
2. TV-SNIP-001: curl output is valid curl command
3. TV-SNIP-002: fetch output is valid JavaScript
4. TV-SNIP-004: python-requests output is valid Python

## Stop Condition
All snippet targets generate valid code. Report supported target count.
