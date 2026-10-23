# SFO-45 clean-room provenance

- Inputs were the SFO-45 Linear issue, its Architecture and Rationale documents, existing uifn contracts, and observable public-product comparison dimensions named in the issue.
- No shadcn/ui or Coss UI source, CSS, prose, examples, screenshots, or assets were copied into this implementation.
- shadcn/ui is used only as the primary rubric reference for API, theming, and source ownership.
- Coss UI is used only as the primary rubric reference for density, information design, finish, state completeness, and documentation cohesion.
- The resulting token names, recipes, selector conventions, visual values, component composition, documentation language, and tests are original uifn work.
- The implementation preserves the existing uifn behavior boundary: core/headless packages own behavior; styled packages own presentation; catalog CSS owns documentation shell presentation only.
