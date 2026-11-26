import {
  createAuthFnClient,
  createBrowserHandoff,
  createWebStorageHandoffStore,
  type AuthFnBrowserHandoffEvent
} from '../../index.js';

/** Bundled into the Chromium contract test page as `window.authfnTest`. */
const events: AuthFnBrowserHandoffEvent[] = [];
const client = createAuthFnClient({ baseUrl: '/auth' });

function make(input: { atomic?: boolean } = {}) {
  return createBrowserHandoff({
    store: createWebStorageHandoffStore(localStorage, input.atomic === false ? { locks: null } : {}),
    allowedOrigins: ['https://app.example.com'],
    exchange: client.exchangeSocialHandoff,
    onEvent: (event) => events.push(event)
  });
}

(globalThis as unknown as { authfnTest: unknown }).authfnTest = { client, events, make };
