# WatchFn revenue producer contract trace — October 26, 2026

Read-only source trace for the next implementation slice. This does not claim revenue support or live provider acceptance. Watch delivery tree currently has stored goal work in progress; revenue methods still return empty objects. Source references below use the local sf-next/next snapshot `b21477fc9a32ae425c38a2de810b5a8705fc711f`, not a freshly fetched hosted head. Revalidate it before implementation.

## Original requirements

Watch SPEC.md:1046–1065 requires `getRevenue` (window, interval, groupBy), `getMRR` (date and breakdown), `getChurnRate` (period/date), and `getLTV` (cohort/projection). Lines1421–1465 show `watch.use(billing)` and a `payment.succeeded` callback with amount/currency/plan/userId. These remain required scope; generic goal aggregation is not revenue accounting.

## Actual producer mismatch

The Watch delivery branch contains only BillFn package manifests, while the local sf-next/next and origin/dev snapshots contain the actual BillFn implementation. Use the existing shared producer rather than duplicating billing persistence in Watch.

- `billfn/core/src/index.ts:1–37` exports `createBillFn`, returning operations/router/providers. It does not return `on`, `addSink`, or a payment event subscription. The original Watch example's `billFn()`/`.on()` names do not match this actual producer.
- `billfn/core/src/types.ts:79–86` defines catalog price amount/currency/kind/interval. The type does not define currency units/exponents or historical immutable payment recognition semantics.
- `types.ts:286–316` verified billing state and parsed webhook contracts contain provider charge/subscription identity and status/period/raw data, but no normalized settled amount/currency/refund amount contract. Provider payload internals must not silently become Watch's public accounting schema.
- `types.ts:187–193` exposes a generic billing event shape. `service.ts:2334–2339` stores it in the private billingEvents model; `BillFnInstance` has no public paginated event export or subscription API.
- `service.ts:2245–2256` emits subscription status records carrying subscription/provider/price IDs. Repeated reconciliation can project a status again; these are not unique cash receipts and cannot be summed as paid revenue.
- `service.ts:826–840` records a refund with request amount optional and currency from the catalog. `service.ts:860–872` records a refund-requested event. `provider-dodo/src/index.ts:252–280` accepts optional custom/prorated amount and returns provider identity/raw response. A full refund may therefore lack a normalized monetary amount. Requested/applied status is not enough for exact recognized refund totals.
- Current Watch `use()` accepts the actual LogFn sink contract only; it is not a billing adapter.

## Next coherent work

First add a producer-side, versioned, replayable normalized billing observation contract with stable provider event/charge/refund identity, occurrence time, billing account/application identity, currency, explicit integer minor-unit amount and immutable subscription/price period snapshots. Resolve actual amount/exponent and refund-state semantics from existing provider docs/source when implementing, rather than inferring catalog price equals collected cash. Keep producer delivery replayable and idempotent; a transient callback alone loses records between billing commit and Watch capture.

Then consume that contract through a distinct Watch billing integration and durable deduplicated records. Define gross/net/refund totals and multiple currencies explicitly; do not add currencies together. Implement `getRevenue` first with bounded interval/grouping and deterministic half-open windows, including duplicate/reordered delivery, refund-only periods, unknown outcomes, tenant separation, reopen and package-level actual producer-consumer acceptance. MRR requires historical recurring subscription facts and explicit monthly normalization; churn needs a defined cohort denominator; projected LTV needs a declared model and incomplete-data behavior. These cannot be replaced by summing arbitrary track events.

BillFn already exists on origin/dev. Any producer prerequisite needs its own correctly routed existing-function change; Watch-only implementation remains on sf-next. Revalidate both remotes and current branches before creating a prerequisite PR. This trace changes no source, remote, provider or user setting.
