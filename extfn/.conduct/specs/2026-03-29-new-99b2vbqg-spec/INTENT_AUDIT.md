# Intent Inventory

1. Build `extfn` as a browser extension development framework similar in capability scope to Plasmo.
2. `extfn` MUST be implemented inside `superfunctions/extfn`.
3. `extfn` MUST have no dependency on WXT.
4. The framework direction MUST be Vite-based.
5. The core MUST be frontend-framework-agnostic.
6. Svelte is the first framework adapter.
7. Validation MUST also include a vanilla non-Svelte path.
8. `nucleus` is a consumer and is not the implementation location.
9. Plugin or integration packages SHOULD live in the owning function package, not inside `extfn`.
10. `datafn` MUST have an `extfn` integration package under `datafn/`.
11. `extfn` MUST expose hooks/interfaces that owning packages can use.
12. `extfn` MUST support background, popup, options, sidepanel, and content contexts.
13. V1 MUST support Chromium MV3.
14. V1 MUST support Firefox MV3.
15. Configuration MUST be code-first.
16. `extfn` MUST support all browser APIs out of the box using the recommended raw-plus-wrapper model.
17. `extfn` MUST support communication between extension parts such as content scripts, background worker, sidepanel, and options.
18. `extfn` MUST support many isolated content modules like the legacy clipper `src/contents/*` shape.
19. `extfn` MUST support anchored content UI and similar per-anchor injection capability.
20. `extfn` MUST support modular background message handlers like the legacy clipper `src/background/messages/*` shape.
21. The spec bundle MUST avoid requiring code changes outside this repository.
22. Validation MUST happen through example extensions inside `extfn`.
23. The spec bundle MUST include consumer guidance covering host abstraction and the SvelteKit-coupled `$app/*` reuse problem on the consumer side.
24. The spec MUST include consumer migration details and usage details for `nucleus`.
25. `extfn` MUST support modular background port handlers similar in capability to the legacy clipper `src/background/ports/*` shape.
26. `extfn` MUST provide typed long-lived channels for persistent cross-context coordination, not only one-shot request/response and broadcast events.
27. `extfn` MUST define deterministic reconnect or explicit-close behavior when MV3 background authority suspends or restarts.
28. `extfn` MUST support style isolation and root normalization for injected content UI so host-page CSS does not silently distort extension components.
29. `extfn` MUST ship a mandatory first-party CLI rather than leaving dev, build, and packaging to package-local scripts.
30. The typical development cycle MUST be driven by CLI commands for watch mode, browser loading, build, packaging, and scan.
31. `extfn` MUST include a build scan command that checks issues aligned with common Chrome review and best-practice concerns.
32. Scan behavior MUST be strict by default and have an explicit opt-out non-strict mode.
33. `extfn` SHOULD reuse or extract existing repository-local utilities where equivalent functionality already exists, especially shared CLI config loading and DataFn extension transport/storage primitives.

# Coverage Map

## 1. Build `extfn` as a browser extension development framework similar in capability scope to Plasmo.

- Covered in `SPEC.md`:
  - `Overview`
  - `Goals / Non-goals`
  - `Semantics`
- Requirement IDs:
  - `CFG-001`
  - `SURF-001`
  - `SURF-002`
  - `CNT-001`
  - `CNT-002`
  - `MSG-001`
- Test vectors:
  - `TV-CFG-001`
  - `TV-SURF-001`
  - `TV-SURF-002`
  - `TV-CNT-001`
  - `TV-CNT-002`

## 2. `extfn` MUST be implemented inside `superfunctions/extfn`.

- Covered in `SPEC.md`:
  - `Overview`
  - `Public API -> Package layout`
- Requirement IDs:
  - `EX-001`
- Test vectors:
  - `TV-EX-001`

## 3. `extfn` MUST have no dependency on WXT.

- Covered in `SPEC.md`:
  - `Goals / Non-goals`
  - `Compatibility / versioning strategy`
- Requirement IDs:
  - `BLD-001`
- Test vectors:
  - `TV-BLD-001`

## 4. The framework direction MUST be Vite-based.

- Covered in `SPEC.md`:
  - `Overview`
  - `Public API -> @superfunctions/extfn-vite`
  - `Semantics -> Build semantics`
- Requirement IDs:
  - `BLD-001`
  - `BLD-002`
  - `BLD-003`
- Test vectors:
  - `TV-BLD-001`
  - `TV-BLD-002`
  - `TV-BLD-003`

## 5. The core MUST be frontend-framework-agnostic.

- Covered in `SPEC.md`:
  - `Goals / Non-goals`
  - `Public API -> @superfunctions/extfn`
  - `Semantics -> Plugin semantics`
- Requirement IDs:
  - `FWK-001`
- Test vectors:
  - `TV-FWK-001`

## 6. Svelte is the first framework adapter.

- Covered in `SPEC.md`:
  - `Overview`
  - `Public API -> @superfunctions/extfn-svelte`
  - `Undefined / Explicitly user-deferred only`
- Requirement IDs:
  - `FWK-002`
- Test vectors:
  - `TV-FWK-002`

## 7. Validation MUST also include a vanilla non-Svelte path.

- Covered in `SPEC.md`:
  - `Overview`
  - `Semantics -> Example validation semantics`
- Requirement IDs:
  - `FWK-002`
  - `EX-001`
- Test vectors:
  - `TV-FWK-002`
  - `TV-EX-001`

## 8. `nucleus` is a consumer and is not the implementation location.

- Covered in `SPEC.md`:
  - `Overview`
  - `Goals / Non-goals`
- Requirement IDs:
  - `DOC-001`
- Test vectors:
  - `TV-DOC-001`

## 9. Plugin or integration packages SHOULD live in the owning function package, not inside `extfn`.

- Covered in `SPEC.md`:
  - `Overview`
  - `Public API -> Package layout`
  - `Semantics -> Plugin semantics`
- Requirement IDs:
  - `PLG-001`
  - `DFX-001`
- Test vectors:
  - `TV-PLG-001`
  - `TV-DFX-001`

## 10. `datafn` MUST have an `extfn` integration package under `datafn/`.

- Covered in `SPEC.md`:
  - `Public API -> Package layout`
  - `Public API -> @datafn/extfn`
  - `Semantics -> DataFn integration semantics`
- Requirement IDs:
  - `DFX-001`
- Test vectors:
  - `TV-DFX-001`

## 11. `extfn` MUST expose hooks/interfaces that owning packages can use.

- Covered in `SPEC.md`:
  - `Public API -> ExtfnPlugin`
  - `Semantics -> Plugin semantics`
- Requirement IDs:
  - `PLG-001`
  - `PLG-002`
- Test vectors:
  - `TV-PLG-001`
  - `TV-PLG-002`

## 12. `extfn` MUST support background, popup, options, sidepanel, and content contexts.

- Covered in `SPEC.md`:
  - `Overview`
  - `Public API -> RuntimeContextKind`
  - `Semantics -> Runtime context semantics`
- Requirement IDs:
  - `SURF-001`
  - `SURF-002`
  - `CTX-001`
  - `CNT-001`
- Test vectors:
  - `TV-SURF-001`
  - `TV-SURF-002`
  - `TV-CTX-001`
  - `TV-CNT-001`

## 13. V1 MUST support Chromium MV3.

- Covered in `SPEC.md`:
  - `Overview`
  - `Compatibility / versioning strategy`
- Requirement IDs:
  - `CFG-002`
  - `BLD-002`
- Test vectors:
  - `TV-CFG-002`
  - `TV-BLD-002`

## 14. V1 MUST support Firefox MV3.

- Covered in `SPEC.md`:
  - `Overview`
  - `Compatibility / versioning strategy`
  - `Semantics -> Browser capability semantics`
- Requirement IDs:
  - `CFG-002`
  - `CTX-003`
  - `BLD-002`
- Test vectors:
  - `TV-CFG-002`
  - `TV-CTX-003`
  - `TV-BLD-002`

## 15. Configuration MUST be code-first.

- Covered in `SPEC.md`:
  - `Overview`
  - `Semantics -> Config semantics`
- Requirement IDs:
  - `CFG-001`
- Test vectors:
  - `TV-CFG-001`

## 16. `extfn` MUST support all browser APIs out of the box using the recommended raw-plus-wrapper model.

- Covered in `SPEC.md`:
  - `Overview`
  - `Public API -> BrowserFacade`
  - `Semantics -> Runtime context semantics`
- Requirement IDs:
  - `CTX-002`
  - `CTX-003`
- Test vectors:
  - `TV-CTX-002`
  - `TV-CTX-003`

## 17. `extfn` MUST support communication between extension parts such as content scripts, background worker, sidepanel, and options.

- Covered in `SPEC.md`:
  - `Overview`
  - `Data formats / protocol`
  - `Semantics -> Messaging semantics`
- Requirement IDs:
  - `MSG-001`
  - `MSG-002`
  - `MSG-003`
- Test vectors:
  - `TV-MSG-001`
  - `TV-MSG-002`
  - `TV-MSG-003`

## 18. `extfn` MUST support many isolated content modules like the legacy clipper `src/contents/*` shape.

- Covered in `SPEC.md`:
  - `Overview`
  - `Semantics -> Content-script semantics`
- Requirement IDs:
  - `CNT-001`
  - `CNT-003`
  - `EX-001`
- Test vectors:
  - `TV-CNT-001`
  - `TV-CNT-003`
  - `TV-EX-001`

## 19. `extfn` MUST support anchored content UI and similar per-anchor injection capability.

- Covered in `SPEC.md`:
  - `Public API -> AnchorStrategy`
  - `Semantics -> Content-script semantics`
- Requirement IDs:
  - `CNT-002`
  - `CNT-003`
- Test vectors:
  - `TV-CNT-002`
  - `TV-CNT-003`

## 20. `extfn` MUST support modular background message handlers like the legacy clipper `src/background/messages/*` shape.

- Covered in `SPEC.md`:
  - `Public API -> BackgroundConfig`
  - `Data formats / protocol -> Background handler module contract`
  - `Semantics -> Background message module semantics`
- Requirement IDs:
  - `SURF-002`
  - `MSG-002`
- Test vectors:
  - `TV-SURF-002`
  - `TV-MSG-002`

## 21. The spec bundle MUST avoid requiring code changes outside this repository.

- Covered in `SPEC.md`:
  - `Overview`
  - `Goals / Non-goals`
- Requirement IDs:
  - `DOC-001`
  - `EX-001`
- Test vectors:
  - `TV-DOC-001`
  - `TV-EX-001`

## 22. Validation MUST happen through example extensions inside `extfn`.

- Covered in `SPEC.md`:
  - `Overview`
  - `Semantics -> Example validation semantics`
- Requirement IDs:
  - `EX-001`
- Test vectors:
  - `TV-EX-001`

## 23. The spec bundle MUST include consumer guidance covering host abstraction and the SvelteKit-coupled `$app/*` reuse problem on the consumer side.

- Covered in `SPEC.md`:
  - `Goals / Non-goals`
  - `Undefined / Explicitly user-deferred only`
- Requirement IDs:
  - `DOC-001`
- Test vectors:
  - `TV-DOC-001`

## 24. The spec MUST include consumer migration details and usage details for `nucleus`.

- Covered in `SPEC.md`:
  - `Overview`
  - `Goals / Non-goals`
- Requirement IDs:
  - `DOC-001`
- Test vectors:
  - `TV-DOC-001`

## 25. `extfn` MUST support modular background port handlers similar in capability to the legacy clipper `src/background/ports/*` shape.

- Covered in `SPEC.md`:
  - `Public API -> BackgroundConfig`
  - `Data formats / protocol -> Background port handler module contract`
  - `Semantics -> Background port module semantics`
- Requirement IDs:
  - `SURF-003`
  - `MSG-004`
- Test vectors:
  - `TV-SURF-003`
  - `TV-MSG-004`

## 26. `extfn` MUST provide typed long-lived channels for persistent cross-context coordination, not only one-shot request/response and broadcast events.

- Covered in `SPEC.md`:
  - `Public API -> RuntimePort`
  - `Public API -> PortClient`
  - `Data formats / protocol -> Runtime port envelopes`
  - `Semantics -> Port semantics`
- Requirement IDs:
  - `MSG-004`
- Test vectors:
  - `TV-MSG-004`

## 27. `extfn` MUST define deterministic reconnect or explicit-close behavior when MV3 background authority suspends or restarts.

- Covered in `SPEC.md`:
  - `Semantics -> Dev semantics`
  - `Semantics -> Port semantics`
  - `Semantics -> DataFn integration semantics`
- Requirement IDs:
  - `MSG-005`
  - `DFX-003`
- Test vectors:
  - `TV-MSG-005`
  - `TV-DFX-003`

## 28. `extfn` MUST support style isolation and root normalization for injected content UI so host-page CSS does not silently distort extension components.

- Covered in `SPEC.md`:
  - `Public API -> ContentScriptConfig`
  - `Semantics -> Content-script semantics`
- Requirement IDs:
  - `CNT-004`
- Test vectors:
  - `TV-CNT-004`

## 29. `extfn` MUST ship a mandatory first-party CLI rather than leaving dev, build, and packaging to package-local scripts.

- Covered in `SPEC.md`:
  - `Overview`
  - `Goals / Non-goals`
  - `Public API -> Package layout`
  - `Public API -> @superfunctions/extfn-cli`
- Requirement IDs:
  - `CLI-001`
- Test vectors:
  - `TV-CLI-001`

## 30. The typical development cycle MUST be driven by CLI commands for watch mode, browser loading, build, packaging, and scan.

- Covered in `SPEC.md`:
  - `Public API -> @superfunctions/extfn-cli`
  - `Semantics -> CLI semantics`
  - `Semantics -> Dev semantics`
- Requirement IDs:
  - `CLI-002`
  - `CLI-003`
- Test vectors:
  - `TV-CLI-002`
  - `TV-CLI-003`

## 31. `extfn` MUST include a build scan command that checks issues aligned with common Chrome review and best-practice concerns.

- Covered in `SPEC.md`:
  - `Public API -> @superfunctions/extfn-cli`
  - `Semantics -> Scan semantics`
  - `Security`
- Requirement IDs:
  - `SCN-001`
- Test vectors:
  - `TV-SCN-001`

## 32. Scan behavior MUST be strict by default and have an explicit opt-out non-strict mode.

- Covered in `SPEC.md`:
  - `Public API -> @superfunctions/extfn-cli`
  - `Semantics -> Scan semantics`
- Requirement IDs:
  - `SCN-002`
  - `CLI-003`
- Test vectors:
  - `TV-SCN-002`
  - `TV-CLI-003`

## 33. `extfn` SHOULD reuse or extract existing repository-local utilities where equivalent functionality already exists, especially shared CLI config loading and DataFn extension transport/storage primitives.

- Covered in `SPEC.md`:
  - `Public API -> Repository reuse plan`
  - `Public API -> @superfunctions/extfn-cli`
- Requirement IDs:
  - `REUSE-001`
- Test vectors:
  - `TV-REUSE-001`

# Audit Result

The pasted ideation, the follow-up CLI request, and the repository reuse review surfaced additional intent around background ports, MV3 reconnect behavior, content style isolation, mandatory CLI ownership, strict review-oriented scan behavior, and reuse of existing repository-local utilities. These items were added to `SPEC.md`, `REQUIREMENTS.md`, `TEST_VECTORS.md`, the phase plans, and the consumer guidance. No missing intent items remain after those corrective edits.
