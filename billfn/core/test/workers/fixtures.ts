/** Fixture values shared by the smoke Worker and the test that drives it. */
export const SMOKE_PRINCIPAL_ID = 'smoke_user';
export const SMOKE_SUBSCRIPTION_ID = 'sub_smoke';
/** Synthetic Standard Webhooks secret, derived at runtime so no secret-shaped literal is committed. */
export const DODO_WEBHOOK_SECRET = `whsec_${btoa('billfn-workers-smoke-secret')}`;
/** The provider subscription the euwest region's Dodo checkout creates. */
export const SMOKE_EU_SUBSCRIPTION_ID = 'sub_smoke_eu';
/** Synthetic shared internal token for the owner lookup, derived at runtime like the webhook secret. */
export const SMOKE_INTERNAL_TOKEN = `itok_${btoa('billfn-workers-smoke-internal')}`;
