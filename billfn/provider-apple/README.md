# @billfn/provider-apple

The Apple provider adapter for BillFn: StoreKit verification, restore and import, App Store Server Notifications v2, notification history and Advanced Commerce cancel and refund. Its built-in App Store Server API token signer and notification verifier run on WebCrypto, so the adapter works on Workers.

```bash
npm install @billfn/provider-apple
```

## One app

```ts
import { createAppleProvider } from "@billfn/provider-apple";

const apple = createAppleProvider({
  bundleId: "com.example.app",
  appStoreServerApiKey: {
    issuerId: process.env.APPLE_ISSUER_ID!,
    keyId: process.env.APPLE_KEY_ID!,
    privateKey: process.env.APPLE_IN_APP_PURCHASE_KEY!, // the .p8 file's PEM
  },
});
```

## Several apps of one developer team

```ts
const apple = createAppleProvider({
  bundleIds: ["com.example.app", "com.example.companion"],
  appStoreServerApiKey: {
    issuerId: process.env.APPLE_ISSUER_ID!,
    keyId: process.env.APPLE_KEY_ID!,
    privateKey: process.env.APPLE_IN_APP_PURCHASE_KEY!, // the team's in-app purchase key
  },
  catalog, // the BillFn catalog, needed when two apps sell one product ID in different plans
});

// Each Apple catalog price names the app it is sold in:
// { priceId: "pro-companion", provider: "apple", providerProductId: "pro.monthly", metadata: { appleBundleId: "com.example.companion" }, ... }
```

Apple product IDs are unique only within an app, so with more than one bundle ID every Apple price must name its app as `metadata.appleBundleId` (`APPLE_BUNDLE_ID_METADATA_KEY`), one of the listed bundle IDs; checkout, verification and restore of a price that names none fail with `BILLFN_VALIDATION_ERROR`. Verification and restore then ask Apple only about that app, and reject a transaction whose signed `bundleId` is another app with `BILLFN_CONFLICT`, so one app's purchase never satisfies another app's price. With a single bundle ID the key is optional; when given, it must name that app. Sync reads a subscription already bound this way from whichever listed app owns it: BillFn core picks a price for a product by product ID alone, so when two apps' prices share a product ID in one plan, a renewal or plan change into that product can record the other app's price of it (same plan, same entitlements). Give each app its own product IDs if the recorded price must always be the app's own.

When two apps sell the same product ID in different plans, pass the BillFn catalog as `catalog`. With more than one bundle ID, `createAppleProvider` then requires every Apple price in it to name a listed app (`BILLFN_VALIDATION_ERROR` otherwise). For a product ID the apps sell in more than one plan, webhook and notification history events (`priceId`) and read billing states (`raw.priceId`) name the catalog price of the app that signed the transaction, which BillFn matches before any product ID, so a renewal or upgrade into that product applies that app's plan. Without `catalog`, BillFn finds the product in several plans, names none of them and keeps the stored plan and entitlements. A product sold in only one plan is matched by product ID as before.

`bundleId`, `bundleIds` or both may be given; at least one is required. Signed transactions and notifications verify only when their signed payload names a listed bundle ID, and are otherwise rejected with `bundle_id_mismatch`. Every App Store Server API token is signed with the one team key and claims as `bid` the app whose transaction it asks about: for import and sync, the adapter asks each listed app in order until Apple's answer is not "transaction not found". A host `tokenProvider` is called with `{ bundleId }` for the same purpose. With more than one bundle ID, notification history pages through each app's history in turn behind one opaque adapter cursor, moving to the next app when Apple answers `hasMore: false` or sends no pagination token. With a single app, `nextCursor` is Apple's pagination token returned unchanged, as before. A stored cursor survives a change of bundle IDs: one naming an app no longer listed restarts from the first listed app, and a plain Apple token from a single-app setup is read as the first app's, so keep that app first when moving from `bundleId` to `bundleIds`.

See the [Apple provider docs](https://github.com/21nCo/superfunctions/blob/dev/billfn/docs/content/docs/providers/apple.mdx) for verification, notifications and Advanced Commerce.
