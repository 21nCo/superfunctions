import {
  createAuthFnClient,
  createBrowserHandoff,
  createIndexedDbHandoffStore,
  type AuthFnBrowserHandoffEvent
} from '../../index.js';

/** Bundled into the Chromium contract test page as `window.authfnTest`. */
const events: AuthFnBrowserHandoffEvent[] = [];
const client = createAuthFnClient({ baseUrl: '/auth' });

/** The page's IndexedDB store; without IndexedDB it is `atomic: false`. */
const store = (input: { atomic?: boolean } = {}) =>
  createIndexedDbHandoffStore(input.atomic === false ? { indexedDB: null } : {});

function make(input: { atomic?: boolean } = {}) {
  return createBrowserHandoff({
    store: store(input),
    allowedOrigins: ['https://app.example.com'],
    exchange: client.exchangeSocialHandoff,
    onEvent: (event) => events.push(event)
  });
}

(globalThis as unknown as { authfnTest: unknown }).authfnTest = { client, events, make, store };
