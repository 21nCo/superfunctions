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

let restored = try await storeKit.restore()
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
- As soon as a transaction is matched to a checkout, before BillFn is asked to verify it, the
  checkout records the transaction id; it is removed only after the transaction is finished. So a
  transaction whose verify call failed, or that the app stopped before finishing, is verified
  against the same checkout on a later launch however late, and no other transaction can take it.
- An outstanding checkout is claimed only by a transaction purchased after its attempt started
  (allowing 15 minutes of clock difference), so restoring an older purchase never takes a pending
  attempt's checkout. A renewal never claims one: renewals carry the same `appAccountToken`, so a
  leftover checkout (a purchase that failed on the network, a declined Ask to Buy request) would
  otherwise be verified with a renewal. From iOS 17 and macOS 14 `Transaction.reason` tells a renewal
  from a purchase. On iOS 16 and macOS 13 the transaction's history (`Transaction.all`) decides: it is
  a renewal when an earlier transaction of the same product in its subscription, not revoked or
  upgraded, was still active when the attempt started or was bought after it. On every system a first
  purchase, an upgrade, a crossgrade or a resubscription bought through its own checkout claims it,
  and a renewal is restored onto its plan (or skipped if none maps). On iOS 16 and macOS 13 a renewal
  that recovers from billing retry after the subscription lapsed before the attempt started looks
  like a resubscription.
- Each transaction BillFn confirms is recorded (the newest 256) before it is finished, so when
  StoreKit offers it again (a redelivered update, `restore()`) it never claims an outstanding checkout.
- When BillFn rejects verifying a transaction against its checkout for good (a non-retryable error,
  such as `BILLFN_CONFLICT`) and a plan maps the product, the transaction is restored onto that plan
  instead and finished. With no plan, it stays unfinished with its checkout and every launch reports
  the same non-retryable failure; resolve it on the BillFn side.
- An outstanding checkout (no transaction yet) is kept for 30 days (`BillFnUserDefaultsCheckoutStore(retention:)`),
  however many other attempts come and go: longer than the App Store keeps an Ask to Buy request
  or an interrupted purchase waiting. Retention takes effect at the next
  `processUnfinishedTransactions()` (run by `start()`), after every unfinished transaction has been
  offered the checkouts it could claim: an expired checkout stays claimable until then, so a purchase
  that completed while the app was not running is still verified against it. A purchase StoreKit refuses before it reaches the App Store
  (`Product.PurchaseError`) or the user cancels drops its checkout at once; any other thrown error
  (such as a network failure) keeps it, since the purchase may still complete.
- `start(updates:)` takes the transaction updates to listen to in place of `Transaction.updates`,
  for example in tests.
- `outcomes` streams every transaction outcome, for example to refresh entitlements.

## Test

```bash
swift test --package-path billfn/swift
billfn/swift/StoreKitTesting/run-tests.sh
```

StoreKit testing needs an app bundle, which `swift test` does not provide, so the StoreKit tests
run in the `StoreKitTesting` macOS host app against `StoreKitTesting/Tests/BillFn.storekit`
(Xcode required).
