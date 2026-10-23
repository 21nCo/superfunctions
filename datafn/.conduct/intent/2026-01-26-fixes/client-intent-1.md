
# Type inference
- When I use `client.<table_name>` - `Property 'table_name' does not exist on type 'DatafnClient'` error
- When I use `client.table(table_name).signal or .query` - the query or signal function is accepting any property inside the object (not adhering to DFQL spec)


# Sync and remote
- The Client itself should take care of remote querying, sync
- The entire acceptance of remote adapter is a drift from original spec
- Direct remote querying, mutation or transact will only be used if `offlinability` is false or during the initial first login `clone` operation when the tables are not fully hydrated yet
- If `offlinability` is true - the client will persist locally first and use `push`, `pull` for syncing changes
- `offlinability` doesn't mean the client is offline always - it means - all the data will be present locally as well and mutations happen on local first (except tables marked as remote only)

Expected shape:
```ts
const client = createDatafnClient({
  schema,
  storage: new IndexedDbStorageAdapter("todo-app-db"),
  clientId: "client-" + Math.random().toString(36).slice(2),
  sync: {
    offlinability: true, // or false 
      remote: "http://localhost:3000/datafn",
      ws: true,
      pushInterval: 2000, // The interval 
      // other sync rules or config like retry config etc
  }
});
```


## How sync should work

### Push
- When new mutations happen 
1. The mutatons are written to mutations table locally first
2. The mutations are applied locally first (Unless the table is marked as remote only)
3. Then the mutations are pushed to remote using the remote URL provided via config and `datafn/push` endpoint exposed via `datafn/server` package used by the consumer on their server
4. On failure, retries should be handled by the client itself
5. After repeated failures - the client should emit an event - so that consumers of the SDK can take action like notifying user etc
6. `pushInterval` is the interval at which the client will push the mutations to the remote (batching all the mutations that happened in that interval and remembering the last pushed mutation id or cursor from previous push success)
   1. If `pushInterval` is not provided, the client will push the mutations to the remote immediately after each mutation is applied locally
7. `pushBatchSize` is the maximum number of mutations that will be pushed to the remote in a single batch (Default: 100)
8. `pushMaxRetries` is the maximum number of retries for a single push operation (Default: 3)


### Pull
- if `ws` is true, the client will use WebSocket to pull the changes from the remote (the websocket connection is established by the client itself)
- if `ws` is false, the client will use HTTP/S to pull the changes from the remote on the following occasions:
  - When the client is first initialized - `clone` operation is called for new login or fresh install
  - If not new login - `pull` operation will be called
  - On Appear or visibility change
  - If the `push` response returns a cursor - the client will use that cursor to pull the changes from the remote
- the client will use the `datafn/pull` endpoint exposed via `datafn/server` package used by the consumer on their server
- pull has pagination and cursor - so the client should handle pagination and cursor management