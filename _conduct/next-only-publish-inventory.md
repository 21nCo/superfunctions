# Next-only npm publish inventory

Generated from source `package.json` files on local `next` compared against `origin/dev`.

Excluded from publish targeting:

- `21n/package.json` (`21n@0.1.1`): org/meta package, not a Superfunctions publish target.
- `watchfn/examples/express-api/package.json` (`watchfn-express-example@1.0.0`): example app, not a library/CLI publish target.

Publish sequence:

1. `browsefn-v0.1.0` - `browsefn@0.1.0` from `browsefn/typescript`
2. `cachefn-core-v0.0.1` - `@cachefn/core@0.0.1` from `cachefn/typescript`
3. `catchfn-v0.0.1` - `catchfn@0.0.1` from `catchfn/typescript`
4. `chartfn-v0.0.1` - `chartfn@0.0.1` from `chartfn`
5. `cifn-control-plane-v0.0.1` - `@cifn/control-plane@0.0.1` from `cifn/typescript/control-plane`
6. `cmsfn-v0.0.1` - `cmsfn@0.0.1` from `cmsfn/core`
7. `cmsfn-server-v0.0.1` - `@cmsfn/server@0.0.1` from `cmsfn/server`
8. `compfn-v0.1.0` - `compfn@0.1.0` from `compfn`
9. `contentfn-core-v0.0.1` - `@contentfn/core@0.0.1` from `contentfn/core`
10. `docsfn-core-v0.0.1` - `@docsfn/core@0.0.1` from `docsfn/core`
11. `drawfn-v0.0.1` - `drawfn@0.0.1` from `drawfn/core`
12. `flowfn-core-v0.0.1` - `@flowfn/core@0.0.1` from `flowfn/typescript`
13. `iconfn-v0.0.1` - `iconfn@0.0.1` from `iconfn`
14. `langfn-v0.1.0` - `langfn@0.1.0` from `langfn/typescript`
15. `logfn-core-v0.1.0` - `@logfn/core@0.1.0` from `logfn/typescript`
16. `plugfn-cli-v0.0.1` - `@plugfn/cli@0.0.1` from `plugfn/cli`
17. `plugfn-v0.0.1` - `plugfn@0.0.1` from `plugfn/typescript`
18. `recfn-v0.1.0` - `recfn@0.1.0` from `recfn/core`
19. `secfn-core-v0.0.1` - `@secfn/core@0.0.1` from `secfn/core`
20. `sendfn-v0.0.1` - `sendfn@0.0.1` from `sendfn/typescript`
21. `testfn-core-v0.0.2` - `@testfn/core@0.0.2` from `testfn/typescript`
22. `uifn-core-v0.0.1` - `@uifn/core@0.0.1` from `uifn/core`
23. `uifn-files-v0.1.0` - `@uifn/files@0.1.0` from `uifn/files`
24. `userfn-v0.0.1` - `userfn@0.0.1` from `userfn/typescript`
25. `watchfn-browser-v0.0.1` - `@watchfn/browser@0.0.1` from `watchfn/agents/browser`
26. `watchfn-cli-v0.0.1` - `@watchfn/cli@0.0.1` from `watchfn/cli`
27. `watchfn-core-v0.0.1` - `@watchfn/core@0.0.1` from `watchfn/typescript`
28. `catchfn-server-v0.0.1` - `@catchfn/server@0.0.1` from `catchfn/server/typescript`
29. `chartfn-react-v0.0.1` - `@chartfn/react@0.0.1` from `chartfn/react`
30. `chartfn-svelte-v0.0.1` - `@chartfn/svelte@0.0.1` from `chartfn/svelte`
31. `cifn-cli-v0.0.1` - `@cifn/cli@0.0.1` from `cifn/typescript/cli`
32. `cifn-runner-v0.0.1` - `@cifn/runner@0.0.1` from `cifn/typescript/runner`
33. `cmsfn-studio-v0.0.1` - `@cmsfn/studio@0.0.1` from `cmsfn/studio`
34. `contentfn-client-v0.0.1` - `@contentfn/client@0.0.1` from `contentfn/client`
35. `contentfn-server-v0.0.1` - `@contentfn/server@0.0.1` from `contentfn/server`
36. `docsfn-next-v0.0.1` - `@docsfn/next@0.0.1` from `docsfn/next`
37. `docsfn-provider-fs-v0.0.1` - `@docsfn/provider-fs@0.0.1` from `docsfn/provider-fs`
38. `docsfn-sveltekit-v0.0.1` - `@docsfn/sveltekit@0.0.1` from `docsfn/sveltekit`
39. `drawfn-react-v0.0.1` - `@drawfn/react@0.0.1` from `drawfn/drawfn-react`
40. `drawfn-svelte-v0.0.1` - `@drawfn/svelte@0.0.1` from `drawfn/drawfn-svelte`
41. `recfn-shared-cloud-v0.1.0` - `recfn-shared-cloud@0.1.0` from `recfn/adapters/shared-cloud`
42. `recfn-whisper-v0.1.0` - `recfn-whisper@0.1.0` from `recfn/adapters/whisper`
43. `recfn-client-v0.1.0` - `recfn-client@0.1.0` from `recfn/client`
44. `recfn-browser-core-v0.1.0` - `recfn-browser-core@0.1.0` from `recfn/platforms/browser-core`
45. `recfn-zoom-v0.1.0` - `recfn-zoom@0.1.0` from `recfn/platforms/zoom`
46. `secfn-runtime-v0.0.1` - `@secfn/runtime@0.0.1` from `secfn/runtime`
47. `secfn-server-v0.0.1` - `@secfn/server@0.0.1` from `secfn/server`
48. `apifn-core-v0.0.1` - `@apifn/core@0.0.1` from `apifn/core`
49. `uifn-react-v0.0.1` - `@uifn/react@0.0.1` from `uifn/react`
50. `uifn-svelte-v0.0.1` - `@uifn/svelte@0.0.1` from `uifn/svelte`
51. `uifn-vue-v0.0.1` - `@uifn/vue@0.0.1` from `uifn/vue`
52. `memoryfn-core-v0.0.1` - `@memoryfn/core@0.0.1` from `memoryfn/typescript`
53. `contentfn-cli-v0.0.1` - `@contentfn/cli@0.0.1` from `contentfn/cli`
54. `docsfn-cli-v0.0.1` - `@docsfn/cli@0.0.1` from `docsfn/cli`
55. `recfn-assemblyai-v0.1.0` - `recfn-assemblyai@0.1.0` from `recfn/adapters/assemblyai`
56. `recfn-deepgram-v0.1.0` - `recfn-deepgram@0.1.0` from `recfn/adapters/deepgram`
57. `recfn-google-stt-v0.1.0` - `recfn-google-stt@0.1.0` from `recfn/adapters/google-stt`
58. `recfn-cli-v0.1.0` - `recfn-cli@0.1.0` from `recfn/cli`
59. `recfn-desktop-v0.1.0` - `recfn-desktop@0.1.0` from `recfn/desktop`
60. `recfn-meet-v0.1.0` - `recfn-meet@0.1.0` from `recfn/platforms/meet`
61. `recfn-teams-v0.1.0` - `recfn-teams@0.1.0` from `recfn/platforms/teams`
62. `secfn-cli-v0.0.1` - `@secfn/cli@0.0.1` from `secfn/cli`
63. `apifn-collections-v0.0.1` - `@apifn/collections@0.0.1` from `apifn/collections`
64. `apifn-mock-v0.0.1` - `@apifn/mock@0.0.1` from `apifn/mock`
65. `apifn-react-v0.0.1` - `@apifn/react@0.0.1` from `apifn/react`
66. `apifn-snippets-v0.0.1` - `@apifn/snippets@0.0.1` from `apifn/snippets`
67. `apifn-svelte-v0.0.1` - `@apifn/svelte@0.0.1` from `apifn/svelte`
68. `docsfn-react-v0.0.1` - `@docsfn/react@0.0.1` from `docsfn/react`
69. `docsfn-svelte-v0.0.1` - `@docsfn/svelte@0.0.1` from `docsfn/svelte`
70. `recfn-server-v0.1.0` - `recfn-server@0.1.0` from `recfn/server`
71. `apifn-cli-v0.0.1` - `@apifn/cli@0.0.1` from `apifn/cli`
72. `apifn-docsfn-v0.0.1` - `@apifn/docsfn@0.0.1` from `apifn/docsfn`

Pre-publish manifest fixes applied:

- Internal source dependencies were pinned to exact local package versions instead of `*`, `file:`, or `workspace:` ranges.
- Missing `publishConfig.access` entries were set to `public`.
- Packages without a `test` script now have a CI-safe no-op `npm test`, and plain `vitest` scripts were changed to `vitest run`.
