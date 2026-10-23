
Agent: Cursor - GPT 5.2 Extra high

----------
# Executive summary
datafn already covers a large chunk of what Flux is doing (local storage, offline changelog + optimistic apply, push/pull/clone sync, events + signals, Svelte adapter, server idempotency + monotonic ordering). But it cannot yet replace Nucleus Flux without either (a) a fairly heavy compatibility layer in Nucleus or (b) several targeted datafn improvements.
The biggest migration blockers (from Nucleus’ current Flux semantics) are:
Local-only mode is missing: Flux supports “no userId = local mode” and still allows mutations; datafn cannot reliably mutate with only storage configured.
Context-aware subscriptions aren’t wired: Nucleus relies on context values in mutation events; datafn filters support only contextKeys, and mutation events don’t carry context today.
Reactive invalidation is too coarse: datafn signals refresh on any mutation of the same resource, which can thrash in a Flux-sized app.
Initial sync/clone scalability: Flux supports “essential clone + pagination + reconcile”; datafn clone returns full tables and pull is global-cursor-only.
Local query performance: current local query executes via full scans; IndexedDB indices exist but are mostly unused by query execution.
Extension/transport injection: Flux has first-class extension delegation; datafn has an extension transport, but the default client cannot inject a custom remote adapter (needed for extension + incremental migration).
What Flux provides in Nucleus (ground truth)
Reactivity + change subscriptions
Flux emits a global mutation window event with { resource, params, context } on every mutation (non-extension), and Nucleus components filter that event by resource/record/context/properties:
flux.ts
Lines 236-289
  async mutation<T extends IResource>(    resource: Resource,    params: IMutationParamsv2<T>,    additionalParams: IMutationAdditionalParams = {}  ) {    // ...    const config = this.tables.find((t) => t.name === resource);    const isCloudOnly = config ? config.isRemoteOnly : true;    if (!isCloudOnly || this.isLocalMode) {      response = await this.persistence.mutation(resource, params);    }    let mutation: IMutation | undefined;    if (      !additionalParams?.isPreventCloudPersistence &&      (!this.isLocalMode || this.isExtensionEnvironment || isCloudOnly)    ) {      mutation = await this.insertMutation(resource, params);    }    // ...    if (!additionalParams?.isPreventSubscriptions) {      if (this.isExtensionEnvironment) {        // relay ExtensionEvent.MUTATION      } else {        dispatchCustomEvent(GlobalEvent.MUTATION, {          resource,          params,          context: additionalParams?.context        });      }      const isInMemory = config?.isInMemory ?? false;      if (isInMemory) {        await this.loadInMemoryResourceStore(resource);      }    }  }
Nucleus’ shared “subscription layer” expects that structure, and filters by context value and merge-property changes:
ComponentBaseLayer.svelte
Lines 86-137
  function onMutation(    e: CustomEvent<{ resource: Resource; params: any; context: string }>  ) {    const data = e.detail;    const mutation = data.params;    if (!data || !mutation) return;    const isMergeAction = [      PersistenceActionType.MERGE,      PersistenceActionType.BULK_MERGE    ].includes(mutation?.action);    // record-level subscriptions (MERGE/BULK_MERGE only)    // ...    if (!subscribeToResource.has(data.resource)) return;    if (subscribeToContext && !subscribeToContext.has(data.context)) return;    // property-level subscriptions for merge    // ...  }
Stores
ResourceStore: CRUD helpers, automatic modifiedAt/modifiedBy, optional debounced persistence, bulk ops, post-filters for “active/archived”, and back-propagation into an ActiveResourceStore (editing state).
KeyValueStore: Svelte-like store that auto-persists MERGE changes (debounced) when $store = ... is used.
Example of debounced persist + active resource back-propagation:
resource.store.ts
Lines 302-339
  async modify(    id: IRecordId,    properties: Partial<T>,    additionalParams?: IResourceMutationParams  ) {    // resolve currentUserId...    const modificationProps = additionalParams?.isModifyAsSystem      ? {}      : { modifiedBy: this.currentUserId, modifiedAt: new Date() };    const activeResource = activeResources.get(id.toString());    if (activeResource && !additionalParams?.isPreventBackPropagation) {      activeResource.update((prev: T) => ({        ...prev,        ...properties,        ...modificationProps      }));    }    const data: Partial<T> = { id, ...properties, ...modificationProps };    if (additionalParams?.isDebounced) {      return this.resolveDebouncerForPersist(        additionalParams.debounceKey ?? id.toString()      )(data);    }    return this.persistModification(data, additionalParams);  }
Sync + offline
Flux has:
Mutation queue (Resource.mutation) for sync-up
Sync-up batching + deletion of synced mutation records
Sync-down applying inserts + deletions, then in-memory reload + syncDown event
Clone-down (v1 offset pagination, v2 cursor pagination)
Reconcile: count-based “repair” to re-clone missing resources
Count-based reconcile:
flux.ts
Lines 1245-1287
  async reconcile(params?: { counts?: any; reCloneAll?: boolean }) {    const resources = this.resolveSyncResources();    let resourcesForReconciliation = [];    if (params?.reCloneAll) {      resourcesForReconciliation = [...resources];    } else {      for (let resource of resources) {        const localCount = (          await this.persistence.selectMany(resource as Resource)        ).length;        const cloudCount = params?.counts?.[resource];        if (localCount < cloudCount) {          resourcesForReconciliation.push(resource);        }      }    }    if (resourcesForReconciliation.length > 0) {      const result = await this.cloneDownV2(resourcesForReconciliation, {        isReconciliation: true      });      if (result?.cursors) {        await this.paginateResourcesV2(result.cursors);      }      if (!params?.reCloneAll) {        this.performSync(SyncMethod.RECONCILE, { resources: resourcesForReconciliation });      }    }  }
What datafn provides today (ground truth)
Reactivity + subscriptions
In-process EventBus with filters on resource, ids, action, fields, and contextKeys:
filter.ts
Lines 7-96
export interface EventFilter {  type?: string | string[];  resource?: string | string[];  ids?: string | string[];  mutationId?: string | string[];  action?: string | string[];  fields?: string | string[];  contextKeys?: string[];}...  // Match contextKeys - all must exist  if (filter.contextKeys !== undefined && filter.contextKeys.length > 0) {    if (!event.context || typeof event.context !== "object") return false;    const ctx = event.context as Record<string, unknown>;    const allExist = filter.contextKeys.every((key) => key in ctx);    if (!allExist) return false;  }
Signals (querySignal) that auto-refresh when a mutation is applied for the same resource:
querySignal.ts
Lines 125-131
  // Listen for mutation_applied events for auto-refresh  eventBus.subscribe((event) => {    if (event.type === "mutation_applied" && event.resource === resource) {      // Trigger refresh      fetchQuery(true);    }  });
Offline mutations + changelog
Offline local apply (handleOfflineMutation) appends to changelog and updates storage optimistically, but only supports record ops (delete/merge/insert/replace) right now (no relation ops).
Sync
Server: clone/pull/push with idempotency + serverSeq change tracking
Client: SyncEngine clone/pull/push, websocket cursor notifications, and a separate cloneUp
Extension transport (partial)
There is a message-bus-backed remote adapter (createExtensionTransport) that can proxy query/mutation/sync and fan-out events, but the default client factory does not allow injecting it (it only builds DefaultHttpTransport from a URL string).
Gap analysis (Flux → datafn) with recommendations
1) Local-only mode (guest / no remote)
Flux: isLocalMode = !userId and still writes locally; sync queue is skipped for local resources.
datafn today: local-first mutations require sync.offlinability && storage && syncEngine; without sync.remote, the remote adapter throws and mutate() can’t safely operate.
Recommendation (P0):
Add a true local-only mode: if storage exists and remote is absent, allow mutate() to apply locally (and optionally log to changelog without pushing).
This can be a config option like sync?: { offlinability: true, remote?: string } or a separate mode: "local-only" | "sync".
2) Transport injection (needed for extension + incremental migration)
Flux: extension bridge delegates calls to background (and web uses /v2/account/relay for remote-only reads).
datafn today: DatafnSyncConfig.remote is a URL and the client always constructs DefaultHttpTransport; it explicitly says adapter injection isn’t supported.
Recommendation (P0):
Allow createDatafnClient({ remote: DatafnRemoteAdapter }) or sync.remoteAdapter?: DatafnRemoteAdapter.
This unlocks:
extension mode (use createExtensionTransport)
a “Flux relay adapter” for phased migration (map DFQL → v2/account/relay until /datafn/* is live)
3) Context-aware subscriptions (Nucleus relies on context values)
Flux/Nucleus: components filter by subscribeToContext.has(data.context) (string value).
datafn today:
Event filtering supports only contextKeys (presence-of-keys)
Mutation events don’t include a context payload at all (only sync_failed/cloneUp use context)
Spec intent: “accept context and propagate it through hooks/logging” and event filters include context (see spec.md).
Recommendation (P0):
Extend DFQL mutation shape to include context?: Record<string, unknown> | string
Emit it on mutation_applied/mutation_rejected
Add filter support for context values (e.g. context: { equals: {...} } or contextTags: string[])
4) Reactive invalidation fidelity + performance
Flux: change events are filtered by resource/records/context/changed-props; components decide what to refresh.
datafn today: every signal for a resource refreshes on every applied mutation for that resource.
Risks in Nucleus scale:
too many signals refreshing → repeated DFQL execution → jank
no batching/debounce despite intent doc saying to avoid thrashing
Recommendation (P0/P1):
Build a signal invalidation index:
register each signal with its “interest”: resource + (optional) ids + (optional) fields + (optional) context filter
on event, refresh only signals whose interest intersects event metadata
Add debounce/batch (microtask or requestAnimationFrame) for bursts of mutations.
5) Store abstractions parity (ResourceStore, ActiveResourceStore, KeyValueStore)
Flux: these are the app-facing API and embed product semantics (archive/trash/lock/edit mode, modifiedBy/modifiedAt, debounced persistence, etc.).
datafn today: schema tables + generic query/mutate; Svelte adapter exists but returns {data,loading,...} not drop-in stores.
Recommendation (P0):
Build a Nucleus-targeted compatibility layer (either in Nucleus or a @datafn/nucleus package):
ResourceStore wrapper implemented on top of datafn.<table>.signal/query/mutate
ActiveResourceStore stays as UI state, but its persistence should go through datafn
KeyValueStore wrapper that persists partial merges with debounce (mirroring Flux KVO)
6) Initial clone scalability (pagination / “essential data” bootstrapping)
Flux: supports limits, cursor pagination (paginateResourcesV2), and an “essential clone then paginate” strategy.
datafn today:
server clone returns all records per table
client cloneNow() clones all non-remote-only tables
Spec intent: storage adapters should support indexed queries; sync should be robust; but current clone is not shaped for very large datasets.
Recommendation (P0):
Add paginated clone:
either per-table cursors (like Flux V2) or
a “clone stream” endpoint that pages deterministically (by id asc, cursor = last id + serverSeq)
Add “boot resources” config to avoid cloning huge tables before app is usable (Flux’s FIR vs IFR boot behavior).
7) Pull cursor model mismatch (spec vs implementation)
Spec: pull sends { cursors: { [table]: cursor } } and returns updated per-table cursors.
Implementation: pull uses a single cursor: string and returns a nextCursor (global change stream).
Recommendation (P1):
Either:
update spec/intent to officially adopt global cursor (simpler), or
implement per-table pull as specified (more work, but aligns with spec + helps partial hydration and selective pulls).
8) Reconciliation / repair (Flux has it; datafn doesn’t)
Flux: detects “large sync down” and triggers full reconcile, and has count-based reconcile.
datafn today: no automatic reconciliation; if state diverges, you’ll stay diverged unless you re-clone manually.
Recommendation (P0/P1):
Add a lightweight repair mechanism:
periodic server “counts/checksum” endpoint per resource
if mismatch, re-clone affected tables (optionally paginated)
9) Local query engine performance + operator coverage
Flux: persistence layer likely uses IndexedDB indices + optimized querying.
datafn today: local query starts from listRecords() (full getAll()) and filters in JS; operators are limited ($and, eq, $gt, $in, $contains).
Recommendation (P0):
Make local query execution index-aware:
detect filters: { field: { eq: ... } } on indexed fields and use storage.findRecords
special-case id lookups to use getRecord
Expand filter support to match what Nucleus actually uses (at least $or, range ops, nullability, nested paths if needed).
10) Offline relation mutations (missing if you adopt DFQL relations)
Flux: models links/tags/etc as resources; mutations are record ops.
datafn today:
server supports relate/unrelate/modifyRelation
offline local apply does not implement these → relations will break offline/local-first if you use them.
Recommendation (P0 if relations are used):
Implement offline apply for relation mutations:
update join stores for many-many
update FK fields for many-one/one-many where applicable
Alternatively, keep Flux’s “links as resources” approach in Nucleus schema initially, and migrate to relations later.
11) ID conventions + typed mapping (prefixes, dates)
Flux: normalizes IDs to resource:id and parses date fields via DataMapper.
datafn today: no built-in idPrefix enforcement or date parsing on read/write.
Recommendation (P0):
Use schema to enforce/assist:
auto-generate ids as ${resource}:${uuid} (or use idPrefix)
parse date fields to Date objects at the client boundary (or provide an optional mapper hook)
12) Sync lifecycle events and client-side beforeSync/afterSync hooks
Intent/spec: sync hooks and rich sync events are part of the design.
datafn today: server runs sync hooks; client defines hook runners but SyncEngine/SyncFacade don’t invoke them consistently, and success events are limited.
Recommendation (P1):
Emit sync_applied for clone/pull/push successes with useful context (phase, cursor delta, counts).
Invoke runBeforeSync/runAfterSync from client sync paths (cloneNow/pullNow/processPush/cloneUp).
13) Server-side authz/permissions enforcement (schema-bounded beyond validation)
Spec intent: enforce table/field permissions.
datafn today: schema validation exists; there’s an optional authorize() callback, but schema permissions isn’t enforced.
Recommendation (P1/P2):
Add a built-in “policy plugin” or default enforcement layer:
reject select/mutate of disallowed fields
enforce write attribution rules, system operations gating, etc.
Practical recommendations (what to do next)
P0: Make datafn viable as a Flux replacement engine
Enable remote adapter injection (required for extension + phased migration).
Add local-only mutation support when storage exists and remote is absent.
Add mutation context propagation + context filtering by value.
Fix reactive invalidation: selective + debounced signal refresh.
Address clone scalability: paginated clone or pull-from-snapshot strategy.
Make local queries index-aware for large tables.
Implement offline relation mutations if DFQL relations are to be used immediately.
P1: Close spec/intent gaps that will matter in production
Decide global cursor vs per-table cursors (and align spec + implementation).
Add reconcile/repair primitives.
Emit richer sync lifecycle events and run client sync hooks.
Start enforcing permissions/authz beyond basic validation.
Migration approach for Nucleus (min-regression)
Step 1: Introduce datafn behind a Flux-compat adapter (keep ComponentBaseLayer patterns working by re-emitting window events during transition).
Step 2: Port ResourceStore and KeyValueStore to thin wrappers over datafn (keep API stable, change internals).
Step 3: Replace ad-hoc window mutation subscriptions with datafn.subscribe() gradually (or bridge datafn events → window events until fully migrated).
Step 4: Extension parity: run authoritative datafn runtime in background + use extension transport in content/sidepanel.
If you want, I can turn this into a concrete checklist keyed to Nucleus resources (resource.config.ts) and produce a “parity test plan” (what to verify per phase: CRUD correctness, subscription correctness, offline correctness, sync correctness, extension correctness).
