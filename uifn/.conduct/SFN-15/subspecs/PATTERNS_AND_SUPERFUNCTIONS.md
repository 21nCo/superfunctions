# Sub-spec: Patterns and Superfunction-backed UI

## Purpose

Define reusable product patterns and Superfunction-backed variants without forcing backend bindings into base components.

## Package Split

`@uifn/patterns` MUST contain controlled, backend-agnostic UI patterns.

`@uifn/sf` MUST contain Superfunction-backed variants that require explicit client props.

## Controlled Pattern Contract

Controlled patterns MUST accept:

- explicit data,
- explicit callbacks,
- explicit loading/empty/error state,
- optional optimistic state,
- optional permission/capability state,
- no required Superfunction client.

Example:

```tsx
<ApiKeyTable
  keys={keys}
  status="success"
  onCreate={handleCreate}
  onRevoke={handleRevoke}
/>
```

## Superfunction-backed Contract

Backed patterns MUST accept injected clients:

```tsx
<AuthFnApiKeyTable authClient={authClient} />
<PlugFnOAuthConnectionsPanel plugClient={plugClient} />
<FileFnUploadPanel fileClient={fileClient} />
<BillFnPlanCards billClient={billClient} />
```

Backed patterns MUST NOT:

- import global clients,
- read auth tokens from globals,
- read secrets from environment variables,
- assume tenant state from app globals,
- emit raw secrets in logs or stories.

## Phase-one Patterns

### authfn

Controlled:

- `AuthPanel`
- `ApiKeyTable`
- `SessionList`
- `UserProfileCard`

Backed:

- `AuthFnAuthPanel`
- `AuthFnApiKeyTable`
- `AuthFnSessionList`
- `AuthFnUserProfileCard`

### plugfn

Controlled:

- `ProviderPicker`
- `OAuthConnectionsPanel`
- `WebhookEndpointTable`

Backed:

- `PlugFnProviderPicker`
- `PlugFnOAuthConnectionsPanel`
- `PlugFnWebhookEndpointTable`

### filefn

Controlled:

- `FileDropzonePanel`
- `UploadProgressList`
- `FileListPanel`
- `QuotaUsagePanel`

Backed:

- `FileFnDropzonePanel`
- `FileFnUploadProgressList`
- `FileFnFileListPanel`
- `FileFnQuotaUsagePanel`

### billfn

Controlled:

- `BillingPlanCards`
- `SubscriptionStatusPanel`
- `InvoiceTable`

Backed:

- `BillFnBillingPlanCards`
- `BillFnSubscriptionStatusPanel`
- `BillFnInvoiceTable`

## Required States

Every pattern MUST include fixtures and stories for:

- loading,
- empty,
- error,
- partial data,
- permission denied,
- optimistic update,
- success,
- degraded network,
- unsupported capability.

## Client Mocks

`@uifn/storybook` MUST provide fake Superfunction clients for Storybook. Mocks MUST use fake credentials and fake tenants.

## Security

Pattern fixtures MUST NOT use realistic secrets, real OAuth tokens, live upload URLs, real customer names, or real billing records.
