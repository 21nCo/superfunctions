# BillFn Swift Bridge

`@billfn/swift-bridge` is the JavaScript bridge package for native-backed `WKWebView` shells.

It implements the `billfn-bridge/v1` protocol and exposes:

- a typed request and event protocol
- a `WKWebView` message bus
- a native-backed BillFn client wrapper

## StoreKit purchases from a web view

When the native host passes a `BillFnStoreKit` to `BillFnBridgeDispatcher` and answers requests
with `respond(to:)`, the client can buy, restore and confirm App Store purchases:

```ts
const billing = createNativeBackedBillFnClient({ clientId: 'web', mode: 'native-backed', baseURL });
await billing.handshake();

const result = await billing.checkout({ planKey: 'pro' }); // 'purchased' | 'pending' | 'cancelled'
const { transactions } = await billing.restore(); // each transaction's outcome
await billing.transactions(); // confirm the unfinished transactions now
billing.subscribe((event) => {
  if (event.event === 'transaction.updated') {
    // a renewal or an approved purchase BillFn processed
  }
});
```

A transaction is finished only once BillFn confirms it (`status: 'confirmed'`); a `failed` or
`skipped` one stays unfinished and is retried on the app's next launch.

`checkout` and `restore` last as long as the App Store purchase sheet or sign-in is open, so they
do not use the 30-second `timeoutMs`: they wait up to `interactiveTimeoutMs` (10 minutes by
default; `0` waits without a timeout). When that runs out, the call rejects with
`BRIDGE_INTERACTIVE_TIMEOUT`. The purchase may still complete in the native app; its outcome then
arrives as a `transaction.updated` event, so keep listening rather than treating it as a failure.

`transactions` waits up to the 30-second `timeoutMs` while the native app confirms each unfinished
transaction with BillFn. When that runs out, the call rejects with `BRIDGE_PROCESSING_TIMEOUT`:
the native app may still be confirming and finishing the transactions, and reports each outcome as a
`transaction.updated` event when it forwards `BillFnStoreKit.outcomes` to the web view (as the Swift
package's embedded web example does).

## Build and test

```bash
npm install
npm run build
npm test
npm pack
```

Run these commands from this package directory. The build typechecks the browser bridge
and emits JavaScript and declarations to `dist`; package exports reference only those
artifacts. Packing runs the same build gate, without downloading ad-hoc compilers.
