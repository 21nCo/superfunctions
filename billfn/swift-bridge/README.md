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
