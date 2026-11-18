# BillFn Swift

`BillFnSwift` provides the native Apple surfaces for BillFn:

- `BillFnClient` for direct HTTP-backed lifecycle calls
- `BillFnStoreKit` for StoreKit 2 purchases, restores and transaction updates through BillFn, and Apple-managed subscription actions
- `BillFnWebViewBridgeHost` for embedded web apps that need native-backed billing ownership

## StoreKit 2 purchases

```swift
let client = BillFnClient(configuration: BillFnClientConfiguration(
    baseURL: URL(string: "https://api.example.com/billfn")!,
    headers: { ["Authorization": "Bearer \(try await session.accessToken())"] }
))
let storeKit = BillFnStoreKit(client: client, plans: [
    BillFnStoreKitPlan(productId: "com.example.pro.month", planKey: "pro", priceId: "price_pro_apple_month"),
])

// At launch, before any purchase: listen to Transaction.updates and retry what earlier launches left unfinished.
await storeKit.start()

switch try await storeKit.purchase(planKey: "pro") {
case .purchased(_, let outcome) where outcome.finished: break // BillFn confirmed it
case .purchased: break // StoreKit charged, BillFn has not confirmed yet: retried on the next launch
case .pending: break // Ask to Buy or another approval; arrives later through Transaction.updates
case .cancelled: break
}

// Only from an explicit Restore Purchases action: syncing with the App Store may ask the user to sign in.
func restorePurchasesTapped() async throws {
    let restored = try await storeKit.restore()
}
```

- `purchase` opens a BillFn Apple checkout (`POST /checkouts`) and buys its product with
  `appAccountToken` set to the billing account token BillFn returns, so BillFn can match the
  transaction to the account.
- A transaction is finished only after BillFn confirms it: a purchase is verified against its
  checkout (`POST /checkouts/verify`); a renewal, an approved Ask to Buy request or a restored
  purchase is restored onto the plan its product maps to (`POST /purchases/restore`). A transaction
  BillFn does not confirm stays unfinished, so StoreKit offers it again and `start()` retries it
  on the next launch.
- The checkout each purchase attempt opened is kept (in `UserDefaults` by default, by its
  `checkoutSessionId`) until its transaction is finished, so a purchase that completes after the
  app quits still verifies against it. A second attempt on the same product does not replace a
  pending one's checkout, and a cancelled or finished attempt removes only its own checkout.
- As soon as a transaction is bound to a checkout, before BillFn is asked to verify it, the store
  records the binding; it is removed once the transaction is finished. Binding is one atomic step
  for every `BillFnStoreKit` sharing the store, and is never undone: a checkout is bound to at most
  one transaction (a transaction gets a second checkout only as its purchase's own one), and each
  binding records whether BillFn confirmed the transaction against it. So a transaction whose verify
  call failed, or that the app stopped before finishing, is verified against the same checkout on a
  later launch however late, and no other transaction can take it. StoreKit can leave an unfinished
  transaction out of `Transaction.unfinished`, so its absence is never taken as finished: the
  transaction is recorded finished once `finish()` returns, and a checkout is removed only once BillFn
  confirmed the transaction against it and that record exists.
- An outstanding checkout is claimed only by a transaction purchased after its attempt started
  (allowing 15 minutes of clock difference), so restoring an older purchase never takes a pending
  attempt's checkout. A renewal never claims one: renewals carry the same `appAccountToken`, so a
  leftover checkout (a purchase that failed on the network, a declined Ask to Buy request) would
  otherwise be verified with a renewal. StoreKit's reason tells a renewal from a purchase:
  `Transaction.reason` from iOS 17 and macOS 14, the signed transaction's `transactionReason` on iOS 16
  and macOS 13. A first purchase, an upgrade, a crossgrade or a resubscription bought through its own
  checkout claims it; a renewal, including one that recovers from billing retry, is restored onto its
  plan (or skipped if none maps). A transaction whose reason is unknown claims no outstanding checkout.
- Each transaction BillFn is asked to confirm is recorded as pending, then confirmed before it is
  finished, then finished. A pending or unfinished one is retried on every launch, from
  `Transaction.all` too, renewals and restored purchases included. A confirmed one offered again (a
  redelivered update, `restore()`) never claims an outstanding checkout. Confirmed records beyond the
  newest 256 are dropped only once no kept checkout could be claimed by their transaction.
- When BillFn rejects verifying a transaction against its checkout for good (a non-retryable error
  with a BillFn error code, such as `BILLFN_CONFLICT`) and a plan maps the product, the transaction is
  restored onto that plan instead and finished. A `BILLFN_HTTP_ERROR` (a gateway or proxy answered
  without a BillFn error envelope) never falls back: the transaction stays unfinished with its checkout. With no plan, it stays unfinished with its checkout and every launch reports
  the same non-retryable failure; resolve it on the BillFn side.
- An outstanding checkout (no transaction yet) is removed only on evidence that its attempt
  produced no transaction: a purchase StoreKit refuses before it reaches the App Store
  (`Product.PurchaseError`) or the user cancels drops its checkout at once. Any other thrown error
  (such as a network failure) keeps it, since the purchase may still complete, and so does time:
  StoreKit gives no evidence that an Ask to Buy request or an interrupted purchase never completes.
  `processUnfinishedTransactions()` (run by `start()`) also confirms each transaction in
  `Transaction.all` that still waits for BillFn (pending or not finished, bound to a checkout BillFn
  has not confirmed it against, or able to claim an outstanding one), since StoreKit can leave an
  unfinished one out of `Transaction.unfinished`.
- `start(updates:)` takes the transaction updates to listen to in place of `Transaction.updates`,
  `processUnfinishedTransactions(_:history:)` the unfinished transactions and the history in place of
  `Transaction.unfinished` and `Transaction.all`,
  and `restore(entitlements:)` the entitlements to confirm in place of `Transaction.currentEntitlements`,
  for example in tests.
- `outcomes` streams every transaction outcome, for example to refresh entitlements: one per
  confirmation pass, in the order the passes end. A transaction offered again while BillFn confirms it
  (an update during a purchase) joins that pass; one that changed meanwhile (refunded), or a purchase's
  own result while a pass without its checkout runs, is confirmed in its own pass after it, so its
  outcome comes last.

## Test

```bash
swift test --package-path billfn/swift
billfn/swift/StoreKitTesting/run-tests.sh
```

StoreKit testing needs an app bundle, which `swift test` does not provide, so the StoreKit tests
run in the `StoreKitTesting` macOS host app against `StoreKitTesting/Tests/BillFn.storekit`
(Xcode required). `run-tests.sh` builds the host app under Xcode's DerivedData folder: StoreKit
testing cannot reach an app under the temporary folder, so it would not deliver
`Transaction.updates`. The production `restore()` test reads `Transaction.currentEntitlements`, which
StoreKit testing reports on macOS 26 (CI) but not on macOS 27, where that test fails; the other
restore tests pass `restore(entitlements:)` the transactions in a set order. The tests that simulate
a purchase error need a host where StoreKit testing applies it (CI does).
