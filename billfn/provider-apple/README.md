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
});
```

`bundleId`, `bundleIds` or both may be given; at least one is required. Signed transactions and notifications verify only when their signed payload names a listed bundle ID, and are otherwise rejected with `bundle_id_mismatch`. Every App Store Server API token is signed with the one team key and claims as `bid` the app whose transaction it asks about: the adapter asks each listed app in order until Apple's answer is not "transaction not found". A host `tokenProvider` is called with `{ bundleId }` for the same purpose. Notification history pages through each app's history in turn behind one opaque cursor, moving to the next app when Apple answers `hasMore: false` or sends no pagination token. A stored cursor survives a change of bundle IDs: one naming an app no longer listed restarts from the first listed app, and a plain Apple token from a single-app setup is read as the first app's, so keep that app first when moving from `bundleId` to `bundleIds`.

See the [Apple provider docs](https://github.com/21nCo/superfunctions/blob/dev/billfn/docs/content/docs/providers/apple.mdx) for verification, notifications and Advanced Commerce.
