# Flux to Datafn Migration Gap Analysis

**Date:** January 28, 2026  
**Scope:** Comprehensive audit of Flux.ts implementation in Nucleus project vs Datafn library capabilities

## Executive Summary

This audit identifies gaps between the current Flux implementation in the Nucleus project and the Datafn library that must be addressed before migration. The analysis covers all workflows, methods, and architectural patterns used in Flux.

**Critical Gaps:** 8  
**High Priority Gaps:** 12  
**Medium Priority Gaps:** 6  
**Low Priority / Nice-to-Have:** 4

---

## 1. Core CRUD Operations

### ✅ Covered
- **Mutation operations**: Datafn supports `insert`, `merge`, `replace`, `delete` (equivalent to Flux's INSERT, MERGE, REPLACE, DELETE)
- **Bulk operations**: Datafn supports bulk mutations via arrays
- **Query operations**: Datafn `query` covers `select` and `selectMany` functionality
- **Select with properties**: Datafn supports field selection via `select` in query

### ⚠️ Gaps

#### 1.1 KV Store Pattern (CRITICAL)
**Flux Implementation:**
- Special `kv:` prefix for key-value stores (`kv:local`, `kv:globalPreferences`, etc.)
- `kvMerge(storeId, data)` method for merging KV records
- `kvSeed(data)` for seeding KV data on signup
- KV records stored in `Resource.kv` table but accessed via `kv:{storeId}` ID pattern

**Datafn Status:** ❌ Not supported
- No special KV store abstraction
- Would need to use regular resources with `kv:` prefix in IDs
- Missing convenience methods like `kvMerge`

**Migration Impact:** HIGH
- 149+ usages of `kv:` pattern across codebase
- Core functionality depends on KV stores (local state, preferences, etc.)

**Recommendation:**
- Add KV store abstraction to Datafn OR
- Document migration pattern: use regular resources with `kv:` prefix IDs
- Create adapter/wrapper for `kvMerge` equivalent

---

## 2. Sync Workflows

### ✅ Covered
- **Clone**: Datafn `clone` covers Flux's `cloneDown` / `cloneDownV2`
- **Pull**: Datafn `pull` covers Flux's `syncDown` (incremental sync)
- **Push**: Datafn `push` covers Flux's `syncUp` (mutation upload)
- **Cursor-based pagination**: Datafn supports cursor pagination

### ⚠️ Gaps

#### 2.1 Clone Up / Local-to-Cloud Upload (CRITICAL)
**Flux Implementation:**
```typescript
async cloneUp() {
  // Uploads ALL local data to cloud
  const resources = this.resolveSyncResources();
  const remoteOnlyResources = this.tables
    .filter((x) => x.isRemoteOnly)
    .map((x) => x.name as Resource);
  const _all = [...resources, ...remoteOnlyResources];
  for (let resource of _all) {
    const records = await this.persistence.selectMany(resource as Resource);
    if (records.length > 0) {
      await this.performSync(SyncMethod.CLONE_UP, {
        resource,
        records
      });
    }
  }
}
```

**Use Case Flow:**
1. User starts app in **offline/local mode** (`isLocalMode = true`, no `userId`)
2. User creates data locally (resources stored in IndexedDB/local storage)
3. User **signs up** → gets `userId`, `isLocalMode` becomes `false`
4. On signup detection (`initState === 2` means local mode was detected):
   ```typescript
   if ($account.sessionType === UserSessionType.NEW) {
     if (initState === 2) {
       await flux.cloneUp(); // Upload all local data to cloud
     }
   }
   ```
5. All local resources are uploaded to cloud server

**Datafn Status:** ❌ **NOT SUPPORTED**
- `seed()` - Only marks database as seeded (idempotency check), doesn't upload data
- `push()` - Designed for incremental mutations from changelog, not bulk upload
- `clone()` - Downloads FROM server TO client (opposite direction)
- **No method exists to upload all existing local data to server**

**Migration Impact:** **CRITICAL**
- **Core signup flow depends on this** - used in `UserBaseLayer.svelte`
- Users who start offline and then sign up will **lose their data** without this
- Critical for offline-first → cloud migration workflow
- Used when `initState === 2` (local mode detected) on new user signup

**Current Workaround (Not Ideal):**
- Could use `push()` but would need to:
  1. Convert all local records to mutations
  2. Add to changelog
  3. Push mutations
- This is inefficient and doesn't match the use case (bulk upload vs incremental sync)

**Recommendation:**
- **URGENT**: Add `cloneUp()` or `upload()` method to `SyncFacade`
- Implement bulk upload of all local resources to server
- Support resource-by-resource upload (like Flux does)
- Ensure idempotency for signup scenarios
- Should accept: `{ clientId, resources?: string[] }` - if resources not specified, upload all
- Server endpoint: `/datafn/cloneup` or extend `/datafn/push` to handle bulk uploads
- Alternative: Extend `push()` to accept bulk mutations without requiring changelog entries

#### 2.2 Reconciliation Workflow (HIGH PRIORITY)
**Flux Implementation:**
```typescript
async reconcile(params?: { counts?: any; reCloneAll?: boolean })
```
- Compares local vs cloud resource counts
- Identifies missing resources
- Triggers clone for resources with mismatched counts
- Supports `reCloneAll` flag for full re-clone

**Datafn Status:** ❌ Not supported
- No built-in reconciliation mechanism
- No count comparison utilities

**Migration Impact:** HIGH
- Used in `UserBaseLayer.svelte` for sync verification
- Critical for data integrity after sync failures

**Recommendation:**
- Add `reconcile` method to SyncFacade
- Implement count comparison logic
- Add reconciliation hooks/events

#### 2.2 Pagination Workflows (HIGH PRIORITY)
**Flux Implementation:**
- `paginateResources(resources, offset, isFirstInitialLoad)` - offset-based
- `paginateResourcesV2(cursors, isFirstInitialLoad)` - cursor-based
- `paginateResource(resource, offset, limit, isFirstInitialLoad)` - per-resource
- Automatic pagination after clone if limit reached

**Datafn Status:** ⚠️ Partial
- Supports cursor pagination in queries
- No dedicated pagination workflow methods
- No automatic pagination after clone

**Migration Impact:** MEDIUM
- Used in clone workflows for large datasets
- Important for initial data load performance

**Recommendation:**
- Add pagination workflow helpers
- Implement automatic pagination after clone
- Support both offset and cursor-based pagination

#### 2.3 Initial Sync Down (MEDIUM PRIORITY)
**Flux Implementation:**
```typescript
async initialSyncDown()
```
- Performs initial sync down for returning cloud users
- Loads in-memory stores after sync
- Propagates sync status

**Datafn Status:** ⚠️ Partial
- `pullNow()` exists but no dedicated initial sync method
- No sync status propagation mechanism

**Migration Impact:** MEDIUM
- Used on app load for returning users
- Important UX for sync feedback

**Recommendation:**
- Add `initialSyncDown()` equivalent
- Add sync status event system

#### 2.4 Sync Status Propagation (MEDIUM PRIORITY)
**Flux Implementation:**
```typescript
propagateSyncStatus(resource: Resource, isFinish?: boolean)
```
- Updates DOM elements with `data-syncstatus` attribute
- Provides visual feedback during sync operations

**Datafn Status:** ❌ Not supported
- No sync status propagation mechanism
- Events exist but no DOM integration

**Migration Impact:** LOW-MEDIUM
- UX feature for sync feedback
- Can be implemented via events

**Recommendation:**
- Add sync status events
- Document DOM integration pattern

---

## 3. Resource Stores & In-Memory Patterns

### ⚠️ Gaps

#### 3.1 In-Memory Store Pattern (CRITICAL)
**Flux Implementation:**
- `isInMemory` flag on resource table config
- `loadInMemoryStores()` loads all in-memory resources
- `loadInMemoryResourceStore(resource)` loads single resource
- `loaderCallback` for populating reactive stores
- Stores subscribe to in-memory data updates

**Datafn Status:** ❌ Not supported
- No in-memory store abstraction
- No automatic loading mechanism
- Storage adapters exist but no reactive store integration

**Migration Impact:** CRITICAL
- Core architecture pattern in Nucleus
- Used extensively for reactive UI updates
- ResourceStore class depends on this pattern

**Recommendation:**
- Add `isInMemory` flag to resource config
- Implement `loadInMemoryStores()` equivalent
- Add loader callback mechanism
- Integrate with reactive stores (Svelte stores)

#### 3.2 ResourceStore Class Pattern (CRITICAL)
**Flux Implementation:**
- `ResourceStore<T>` class with methods: `create`, `modify`, `delete`, `select`, `selectMany`
- `ActiveResourceStore<T>` for single resource reactive state
- Debounced modifications
- Bulk operations (`bulkModify`, `bulkTrash`)
- Archive/restore/trash workflows

**Datafn Status:** ❌ Not supported
- Datafn provides `table()` API but no ResourceStore class
- No ActiveResourceStore equivalent
- No built-in debouncing

**Migration Impact:** CRITICAL
- Entire application architecture depends on ResourceStore pattern
- 100+ files use ResourceStore/ActiveResourceStore

**Recommendation:**
- Create ResourceStore adapter/wrapper around Datafn `table()` API
- Implement ActiveResourceStore pattern
- Add debouncing utilities
- Maintain API compatibility during migration

#### 3.3 Store Resolver Pattern (MEDIUM PRIORITY)
**Flux Implementation:**
- `ResourceStore.resolve<T>(resource)` - singleton pattern
- `ActiveResourceStore.resolve<T>(id)` - singleton pattern
- Global registry: `resourceStores`, `activeResources`

**Datafn Status:** ❌ Not supported
- No singleton resolver pattern
- No global registry

**Migration Impact:** MEDIUM
- Used throughout codebase for store access
- Can be implemented as adapter layer

**Recommendation:**
- Implement resolver pattern as adapter
- Maintain compatibility during migration

---

## 4. Extension Environment Support

### ⚠️ Gaps

#### 4.1 Extension Environment Detection & Handling (HIGH PRIORITY)
**Flux Implementation:**
- `isExtensionEnvironment` flag
- `syncForExtension(mutation)` - immediate sync for extensions
- `extensionFlux(method)` - delegation to background script
- `delegateToFlux(method)` - mediator pattern
- Different sync behavior for extensions (immediate vs batched)

**Datafn Status:** ❌ Not supported
- No extension environment detection
- No special extension sync handling
- No RPC/delegation mechanism

**Migration Impact:** HIGH
- Extension functionality depends on this
- Used in browser extension contexts

**Recommendation:**
- Add extension environment detection
- Implement extension RPC transport
- Add immediate sync mode for extensions
- Create extension adapter/delegation layer

#### 4.2 Extension Store Pattern (MEDIUM PRIORITY)
**Flux Implementation:**
- `ExtensionStore` class for extension-specific stores
- Delegates Flux methods to background script
- Handles extension-specific initialization

**Datafn Status:** ❌ Not supported
- No extension-specific store pattern

**Migration Impact:** MEDIUM
- Used in extension contexts
- Can be implemented as adapter

**Recommendation:**
- Create ExtensionStore adapter
- Implement RPC transport for extensions

---

## 5. Data Transformation & Mapping

### ⚠️ Gaps

#### 5.1 DataMapper Pattern (HIGH PRIORITY)
**Flux Implementation:**
- `DataMapper` class for data transformation
- Date parsing (string → Date objects)
- Encryption/decryption hooks
- Resource-specific transformations
- `parse(resource, records)` method

**Datafn Status:** ❌ Not supported
- No data mapper abstraction
- No automatic date parsing
- No encryption hooks

**Migration Impact:** HIGH
- Critical for data type correctness
- Used in sync operations (cloneDown, syncDown)
- Date parsing is essential

**Recommendation:**
- Add DataMapper interface/implementation
- Implement date parsing
- Add encryption hooks
- Support resource-specific transformations

#### 5.2 Date Field Mapping (HIGH PRIORITY)
**Flux Implementation:**
- Automatic parsing of: `createdAt`, `modifiedAt`, `date`, `startDate`, `endDate`
- Converts ISO strings to Date objects

**Datafn Status:** ❌ Not supported
- No automatic date parsing
- Dates stored as strings or numbers

**Migration Impact:** HIGH
- Date handling is critical for application logic
- Many features depend on Date objects

**Recommendation:**
- Add date parsing to Datafn
- Support configurable date fields
- Add date serialization/deserialization

---

## 6. Query & Search Capabilities

### ✅ Covered
- **Filters**: Datafn supports complex filters
- **Sorting**: Datafn supports multi-field sorting
- **Pagination**: Datafn supports cursor-based pagination
- **Select/Expand**: Datafn supports field selection and relations
- **Aggregations**: Datafn supports `groupBy` aggregations

### ⚠️ Gaps

#### 6.1 Search Method (MEDIUM PRIORITY)
**Flux Implementation:**
```typescript
async search(storeId: string, query: string)
```
- Dedicated search method for stores
- Used in `SearchResultsPopover` component
- Integrates with FlexSearch or similar

**Datafn Status:** ⚠️ Partial
- Search supported via `searchfn` plugin
- No dedicated `search()` method on client
- Search integrated into query API

**Migration Impact:** MEDIUM
- Used in search UI components
- Can be adapted to query API

**Recommendation:**
- Add convenience `search()` method
- Document search query pattern
- Ensure searchfn plugin compatibility

#### 6.2 Query by Query String (LOW PRIORITY)
**Flux Implementation:**
```typescript
async selectByQuery(query: string, params?: any)
```
- Direct SQL/query string execution
- Used for complex queries

**Datafn Status:** ❌ Not supported
- No raw query execution
- DFQL only

**Migration Impact:** LOW
- Limited usage
- Can be migrated to DFQL

**Recommendation:**
- Document DFQL migration patterns
- Add query builder utilities if needed

---

## 7. Sync Configuration & State Management

### ⚠️ Gaps

#### 7.1 Local State Management (HIGH PRIORITY)
**Flux Implementation:**
- `kv:local` record stores sync state
- Fields: `lastSyncDown`, `dapId`, `version`
- `resolveLocal()` method
- `resolveDapId(local)` method
- Automatic dapId resolution and storage

**Datafn Status:** ⚠️ Partial
- Cursor storage exists but no `kv:local` equivalent
- No dapId management
- No sync state record pattern

**Migration Impact:** HIGH
- Critical for sync state tracking
- Used throughout sync workflows

**Recommendation:**
- Add sync state management
- Implement `kv:local` equivalent or migration pattern
- Add dapId management utilities

#### 7.2 Resource Type Resolution (MEDIUM PRIORITY)
**Flux Implementation:**
- `resolveSyncResources()` - filters non-remote-only resources
- `resolveFIRResources()` - finite resources for initial clone
- `resolveIFRBootResources()` - infinite resources for boot
- Resource categorization by `dataType` (FIR, IFR, KVO)

**Datafn Status:** ⚠️ Partial
- Resources exist but no categorization helpers
- No FIR/IFR distinction

**Migration Impact:** MEDIUM
- Used in clone workflows
- Important for initial load optimization

**Recommendation:**
- Add resource categorization helpers
- Support FIR/IFR distinction
- Add sync resource resolution utilities

#### 7.3 Remote-Only Resources (MEDIUM PRIORITY)
**Flux Implementation:**
- `isRemoteOnly` flag on resource config
- `remoteRelay()` method for cloud-only queries
- Automatic routing to remote for remote-only resources

**Datafn Status:** ⚠️ Partial
- Can be implemented but no built-in support
- No automatic remote routing

**Migration Impact:** MEDIUM
- Used for cloud-only resources
- Important for hybrid local/cloud architecture

**Recommendation:**
- Add `isRemoteOnly` flag support
- Implement automatic remote routing
- Add remote relay pattern

---

## 8. Mutation Tracking & History

### ✅ Covered
- **Mutation logging**: Datafn tracks mutations in changelog
- **Idempotency**: Datafn supports mutation deduplication
- **Change tracking**: Datafn tracks changes with serverSeq

### ⚠️ Gaps

#### 8.1 Mutation Table Pattern (MEDIUM PRIORITY)
**Flux Implementation:**
- `Resource.mutation` table stores all mutations
- `insertMutation()` creates mutation records
- Mutations include: `id`, `timestamp`, `userId`, `resource`, `params`, `resourceId`, `action`
- Used for sync up and versioning

**Datafn Status:** ⚠️ Partial
- Changelog exists but different structure
- No mutation table equivalent
- Different mutation format

**Migration Impact:** MEDIUM
- Used for sync workflows
- Important for debugging and audit

**Recommendation:**
- Document changelog vs mutation table differences
- Add migration utilities if needed
- Ensure sync compatibility

---

## 9. Event System & Subscriptions

### ✅ Covered
- **Event bus**: Datafn has event bus system
- **Subscriptions**: Datafn supports event subscriptions
- **Event filtering**: Datafn supports event filters

### ⚠️ Gaps

#### 9.1 GlobalEvent Integration (MEDIUM PRIORITY)
**Flux Implementation:**
- `GlobalEvent.MUTATION` - dispatched on mutations
- `GlobalEvent.SYNC_DOWN` - dispatched on sync down
- `dispatchCustomEvent()` for DOM events
- Integration with Svelte event system

**Datafn Status:** ⚠️ Partial
- Events exist but different naming
- No DOM event integration
- No Svelte integration

**Migration Impact:** MEDIUM
- Used throughout UI for reactivity
- Important for component updates

**Recommendation:**
- Add GlobalEvent compatibility layer
- Integrate with Svelte stores
- Add DOM event dispatch if needed

---

## 10. Offline & Network Handling

### ✅ Covered
- **Offline detection**: Can be implemented
- **Offline mutations**: Datafn supports offline changelog
- **Retry logic**: Datafn has retry mechanisms

### ⚠️ Gaps

#### 10.1 Offline Detection Integration (LOW PRIORITY)
**Flux Implementation:**
- `determineIfOffline()` method
- Used to route queries (local vs remote)
- Affects sync behavior

**Datafn Status:** ⚠️ Partial
- Can be implemented but not built-in
- No automatic offline routing

**Migration Impact:** LOW
- Can be added as utility
- Important for offline-first apps

**Recommendation:**
- Add offline detection utility
- Document offline routing patterns

---

## 11. Advanced Features

### ⚠️ Gaps

#### 11.1 Export/Import Functionality (LOW PRIORITY)
**Flux Implementation:**
- `export()` - exports all resources to JSON
- `import(data)` - imports JSON backup
- Used for backup/restore

**Datafn Status:** ❌ Not supported
- No built-in export/import

**Migration Impact:** LOW
- Used for backup functionality
- Can be implemented as utility

**Recommendation:**
- Add export/import utilities
- Document backup/restore patterns

#### 11.2 Background Indexing (LOW PRIORITY)
**Flux Implementation:**
- `index()` method triggers background indexing
- `triggerBackgroundIndexing()` on persistence layer
- Used for search index updates

**Datafn Status:** ❌ Not supported
- No background indexing mechanism

**Migration Impact:** LOW
- Used for search functionality
- Can be handled by searchfn plugin

**Recommendation:**
- Document indexing patterns
- Integrate with searchfn plugin

#### 11.3 Seed Functionality (MEDIUM PRIORITY)
**Flux Implementation:**
- `seed()` method for initial data setup
- `kvSeed(data)` for KV seed data
- Used on user signup

**Datafn Status:** ✅ Supported
- `seed()` method exists in sync facade

**Migration Impact:** LOW
- Already supported

**Recommendation:**
- Verify seed API compatibility
- Document migration pattern

---

## 12. Architecture Patterns

### ⚠️ Gaps

#### 12.1 Singleton Pattern (CRITICAL)
**Flux Implementation:**
- `Flux._instance` - singleton pattern
- `flux` global export
- `initFlux()` initializes singleton

**Datafn Status:** ⚠️ Different
- Client created via factory function
- No singleton pattern
- Multiple clients possible

**Migration Impact:** CRITICAL
- Entire codebase assumes singleton
- Global `flux` variable used everywhere

**Recommendation:**
- Create singleton wrapper/adapter
- Maintain global `flux` variable compatibility
- Document migration to multi-client if desired

#### 12.2 Initialization Pattern (HIGH PRIORITY)
**Flux Implementation:**
- `initFlux(persistence, params)` - initialization
- `initializeEssentialDataForCloudUserV2()` - initial clone
- `afterInitialize()` - post-init hooks
- Table configuration via `IResourceTableConfig[]`

**Datafn Status:** ⚠️ Different
- `createDatafnClient(config)` - factory pattern
- Different initialization flow
- Schema-based configuration

**Migration Impact:** HIGH
- Different initialization patterns
- Need adapter layer

**Recommendation:**
- Create initialization adapter
- Map table config to schema
- Maintain compatibility layer

---

## Priority Summary

### CRITICAL (Must Fix Before Migration)
1. ✅ **Clone Up / Local-to-Cloud Upload** - Users lose data on signup without this
2. ✅ KV Store Pattern
3. ✅ In-Memory Store Pattern  
4. ✅ ResourceStore Class Pattern
5. ✅ Singleton Pattern

### HIGH PRIORITY (Should Fix Before Migration)
5. ✅ Reconciliation Workflow
6. ✅ Pagination Workflows
7. ✅ Extension Environment Support
8. ✅ DataMapper Pattern
9. ✅ Date Field Mapping
10. ✅ Local State Management
11. ✅ Initialization Pattern

### MEDIUM PRIORITY (Can Fix During Migration)
12. ✅ Initial Sync Down
13. ✅ Sync Status Propagation
14. ✅ Store Resolver Pattern
15. ✅ Extension Store Pattern
16. ✅ Resource Type Resolution
17. ✅ Remote-Only Resources
18. ✅ Mutation Table Pattern
19. ✅ GlobalEvent Integration
20. ✅ Seed Functionality

### LOW PRIORITY (Nice to Have)
21. ✅ Search Method
22. ✅ Query by Query String
23. ✅ Offline Detection Integration
24. ✅ Export/Import Functionality
25. ✅ Background Indexing

---

## Recommended Migration Strategy

### Phase 1: Critical Adapters (Pre-Migration)
1. Create singleton wrapper around Datafn client
2. Implement ResourceStore adapter using Datafn `table()` API
3. Implement KV store abstraction
4. Implement in-memory store loading mechanism
5. Create DataMapper with date parsing

### Phase 2: Sync Workflows (Migration Prep)
1. Implement reconciliation workflow
2. Add pagination workflow helpers
3. Implement extension environment support
4. Add local state management (`kv:local` equivalent)

### Phase 3: Migration Execution
1. Replace Flux with Datafn + adapters
2. Migrate ResourceStore usages
3. Migrate sync workflows
4. Test extension environments

### Phase 4: Cleanup & Optimization
1. Remove adapter layers where possible
2. Optimize sync workflows
3. Add missing features as needed

---

## Conclusion

Datafn provides a solid foundation for replacing Flux, but **critical gaps exist** in:
- KV store patterns
- In-memory store architecture
- ResourceStore class pattern
- Singleton/initialization patterns

**Recommendation:** Create adapter/compatibility layer to bridge these gaps before attempting full migration. This will allow gradual migration while maintaining application functionality.

**Estimated Effort:** 
- Critical adapters: 2-3 weeks
- Sync workflows: 1-2 weeks  
- Migration execution: 4-6 weeks
- Testing & cleanup: 2-3 weeks

**Total:** 9-14 weeks for complete migration
