# TEST VECTORS: Lifecycle-Aware Signals

## LiveSignal Core

### TV-LIVE-001: LiveSignal implements DatafnSignal interface

- **Vector ID**: TV-LIVE-001
- **Description**: LiveSignal exposes all DatafnSignal properties and methods, delivering values to subscribers.
- **Input**:
  ```typescript
  const schema = defineSchema({
    resources: [{ name: "task", version: 1, fields: [{ name: "title", type: "string", required: true }] }],
  });
  const client = createDatafnClient({
    schema,
    clientId: "test-01",
    storage: new MemoryStorageAdapter(["task", "kv"]),
    remote: stubRemote, // returns { data: [{ id: "t1", title: "Buy milk" }] } for queries
  });

  const signal = client.task.signal({ select: ["*"] });
  ```
- **Expected output**:
  - `typeof signal.get` === `"function"`
  - `typeof signal.subscribe` === `"function"`
  - `typeof signal.dispose` === `"function"`
  - `typeof signal.loading` === `"boolean"`
  - `signal.error` === `null` (no error)
  - After subscribe and data arrives: `signal.get()` returns `{ data: [{ id: "t1", title: "Buy milk" }], nextCursor: null }`
  - Subscriber receives the same value.
- **Negative variant**: After `signal.dispose()`, `signal.subscribe(handler)` returns an unsubscribe function but `handler` is never called.

### TV-LIVE-002: LiveSignal get() reflects current raw signal

- **Vector ID**: TV-LIVE-002
- **Description**: `get()` delegates to the underlying raw signal's current value.
- **Input**:
  ```typescript
  const signal = client.task.signal({ select: ["*"] });
  // Wait for data to load
  await waitForSignalValue(signal);
  const value1 = signal.get();

  // Perform a mutation
  await client.task.mutate({ action: "insert", data: { id: "t2", title: "Walk dog" } });
  // Wait for signal refresh
  await waitForSignalValue(signal);
  const value2 = signal.get();
  ```
- **Expected output**:
  - `value1.data` has 1 record.
  - `value2.data` has 2 records (after mutation-triggered refresh).
- **Negative variant**: N/A.

### TV-LIVE-003: LiveSignal survives switchContext and emits new data

- **Vector ID**: TV-LIVE-003
- **Description**: After `switchContext()`, existing subscribers receive data from the new raw client.
- **Input**:
  ```typescript
  const client = createDatafnClient({
    schema,
    clientId: "test-01",
    storage: storageFactory,
    authContext: { userId: "user-A" },
    remote: stubRemoteA, // returns tasks for user A
  });

  const signal = client.task.signal({ select: ["*"] });
  const receivedValues: any[] = [];
  signal.subscribe((v) => receivedValues.push(v));

  // Wait for initial data (user A's tasks)
  await waitForSignalValue(signal);

  // Switch to user B
  await client.switchContext({
    authContext: { userId: "user-B" },
    storage: new MemoryStorageAdapter(["task", "kv"]),
  });
  // stubRemoteB would return user B's tasks

  await waitForSignalValue(signal);
  ```
- **Expected output**:
  - `receivedValues.length >= 2` (at least one from user A, one from user B).
  - Last value in `receivedValues` contains user B's data.
  - `signal.get()` returns user B's data.
  - The signal object identity is unchanged (`signal` before and after switch is `===`).
- **Negative variant**: If `switchContext` is called with invalid config that causes factory to throw, `signal.error` is set to a `DatafnError`.

### TV-LIVE-004: LiveSignal factory uses new realClient after switch

- **Vector ID**: TV-LIVE-004
- **Description**: The factory closure captures `realClient` by reference. After switch, re-calling factory creates a signal on the new client.
- **Input**:
  ```typescript
  const client = createDatafnClient({ schema, clientId: "test-01", storage: storageA, remote: remoteA });

  const signal = client.task.signal({ select: ["*"] });
  // signal is bound to remoteA

  await client.switchContext({ storage: storageB, remote: remoteB });
  // signal is now bound to remoteB

  await client.task.mutate({ action: "insert", data: { id: "t99", title: "New task" } });
  ```
- **Expected output**:
  - The mutation goes through `remoteB` (not `remoteA`).
  - The signal refreshes from `remoteB`'s data.
  - `remoteA.query` is NOT called after the switch.
- **Negative variant**: N/A.

### TV-LIVE-005: LiveSignal dispose cleans up

- **Vector ID**: TV-LIVE-005
- **Description**: After dispose, the LiveSignal is inert and does not participate in rebinds.
- **Input**:
  ```typescript
  const signal = client.task.signal({ select: ["*"] });
  await waitForSignalValue(signal);

  signal.dispose();

  await client.switchContext({ authContext: { userId: "user-B" } });
  ```
- **Expected output**:
  - No error thrown during switchContext (disposed signal is skipped).
  - `signal.get()` returns the last cached value from before dispose.
  - `signal.loading` is `false`.
  - `signal.error` is `null`.
  - `signal.subscribe(handler)` — `handler` is never called.
- **Negative variant**: N/A.

### TV-LIVE-006: LiveSignal double dispose is safe

- **Vector ID**: TV-LIVE-006
- **Description**: Calling dispose() twice does not throw.
- **Input**:
  ```typescript
  const signal = client.task.signal({ select: ["*"] });
  signal.dispose();
  signal.dispose(); // second call
  ```
- **Expected output**:
  - No error thrown.
  - Signal state is identical to after first dispose.
- **Negative variant**: N/A.

### TV-LIVE-007: LiveSignal error handling during rebind

- **Vector ID**: TV-LIVE-007
- **Description**: If a signal's factory throws during rebind, the error is captured, not thrown.
- **Input**:
  ```typescript
  // Create a signal for resource "task"
  const signal = client.task.signal({ select: ["*"] });

  // Switch to a client whose _buildRawClient throws for "task" table
  // (simulated by making the new storage throw on initialization)
  ```
- **Expected output**:
  - `rebindAll()` does not throw.
  - `signal.error` is a `DatafnError` (or wrapped error).
  - `signal.loading` is `false`.
  - Other signals (if any) are rebound successfully.
- **Negative variant**: N/A.

### TV-LIVE-008: Client destroy disposes all LiveSignals

- **Vector ID**: TV-LIVE-008
- **Description**: `client.destroy()` disposes all LiveSignals.
- **Input**:
  ```typescript
  const sig1 = client.task.signal({ select: ["*"] });
  const sig2 = client.kv.signal("theme");

  await client.destroy();
  ```
- **Expected output**:
  - Both signals are disposed (loading: false, error: null).
  - `sig1.subscribe(handler)` — handler not called.
  - `sig2.subscribe(handler)` — handler not called.
- **Negative variant**: N/A.

---

## LiveSignalRegistry

### TV-REG-001: Registry deduplication

- **Vector ID**: TV-REG-001
- **Description**: Same signal key returns the same LiveSignal instance.
- **Input**:
  ```typescript
  const q = { select: ["*"], sort: ["-createdAt"] };
  const sig1 = client.task.signal(q);
  const sig2 = client.task.signal(q);
  const sig3 = client.task.signal({ select: ["*"] }); // different query
  ```
- **Expected output**:
  - `sig1 === sig2` is `true`.
  - `sig1 === sig3` is `false`.
- **Negative variant**: N/A.

### TV-REG-002: Registry re-creation after dispose

- **Vector ID**: TV-REG-002
- **Description**: After a signal is disposed, creating one with the same key produces a new instance.
- **Input**:
  ```typescript
  const q = { select: ["*"] };
  const sig1 = client.task.signal(q);
  sig1.dispose();
  const sig2 = client.task.signal(q);
  ```
- **Expected output**:
  - `sig1 === sig2` is `false`.
  - `sig2` is fully functional (can subscribe, get data).
- **Negative variant**: N/A.

---

## Proxy Integration

### TV-PROXY-001: table().signal() and dynamic accessor both produce LiveSignals

- **Vector ID**: TV-PROXY-001
- **Description**: Both `client.table("task").signal(q)` and `client.task.signal(q)` create LiveSignals that survive switches.
- **Input**:
  ```typescript
  const sigA = client.table("task").signal({ select: ["*"] });
  const sigB = client.task.signal({ select: ["*"] });
  ```
- **Expected output**:
  - `sigA === sigB` (same key → deduplicated).
  - Both survive `switchContext()` (per TV-LIVE-003).
- **Negative variant**: N/A.

### TV-PROXY-002: kv.signal() produces LiveSignal

- **Vector ID**: TV-PROXY-002
- **Description**: `client.kv.signal(key)` creates a LiveSignal that survives switches.
- **Input**:
  ```typescript
  const themeSig = client.kv.signal("theme", { defaultValue: "light" });
  await waitForSignalValue(themeSig);

  const valueBefore = themeSig.get();
  await client.switchContext({ authContext: { userId: "user-B" } });
  await waitForSignalValue(themeSig);
  const valueAfter = themeSig.get();
  ```
- **Expected output**:
  - `themeSig` is a `DatafnSignal<unknown>`.
  - `valueAfter` may differ from `valueBefore` (different user's KV data).
  - `themeSig` instance identity unchanged.
- **Negative variant**: N/A.

### TV-PROXY-003: No infinite recursion

- **Vector ID**: TV-PROXY-003
- **Description**: Creating a signal does not cause stack overflow.
- **Input**:
  ```typescript
  const signal = client.task.signal({ select: ["*"] });
  ```
- **Expected output**:
  - Signal created successfully (no `RangeError: Maximum call stack size exceeded`).
  - Signal is functional.
- **Negative variant**: If the factory accidentally routes through the Proxy, a `RangeError` or infinite loop would occur. This MUST NOT happen.

### TV-PROXY-004: Non-signal table methods pass through

- **Vector ID**: TV-PROXY-004
- **Description**: Table methods other than `signal()` work normally through the Proxy.
- **Input**:
  ```typescript
  const result = await client.task.query({ select: ["*"] });
  await client.task.mutate({ action: "insert", data: { id: "t1", title: "Test" } });
  ```
- **Expected output**:
  - `result` is the query response from the remote adapter.
  - Mutation succeeds.
  - `client.task.name` === `"task"`.
  - `client.task.version` === `1`.
- **Negative variant**: N/A.

---

## Type System

### TV-TYPE-001: defineSchema preserves literal resource names

- **Vector ID**: TV-TYPE-001
- **Description**: The return type of `defineSchema` includes literal resource name types.
- **Input**:
  ```typescript
  const schema = defineSchema({
    resources: [
      { name: "todos", version: 1, fields: [{ name: "title", type: "string" as const, required: true }] },
      { name: "tags", version: 1, fields: [{ name: "label", type: "string" as const, required: true }] },
    ],
  });
  type Names = ResourceNames<typeof schema>;
  // Expected: Names = "todos" | "tags"

  const client = createDatafnClient({ schema, clientId: "t", storage: new MemoryStorageAdapter(["todos", "tags", "kv"]) });
  const table = client.table("todos"); // should compile
  const table2 = client.todos; // should compile (dynamic accessor)
  ```
- **Expected output** (compile-time):
  - `Names` is `"todos" | "tags"` (not `string`).
  - `client.table("todos")` compiles without error.
  - `client.todos` compiles without error.
  - `client.table("nonexistent")` produces a TypeScript error.
- **Negative variant**:
  ```typescript
  client.table("nonexistent"); // TS error: Argument of type '"nonexistent"' is not assignable to parameter of type '"todos" | "tags"'
  ```

### TV-TYPE-002: createDatafnClient infers literal names from defineSchema

- **Vector ID**: TV-TYPE-002
- **Description**: Client created with a `defineSchema` result has typed table accessors.
- **Input**:
  ```typescript
  const schema = defineSchema({
    resources: [
      { name: "items", version: 1, fields: [{ name: "name", type: "string" as const, required: true }] },
    ],
  });
  const client = createDatafnClient({ schema, clientId: "t", storage: mem });
  ```
- **Expected output** (compile-time):
  - `client.items` is `DatafnTable<typeof schema, "items">`.
  - `client.items.signal({ select: ["*"] })` returns `DatafnSignal<unknown>`.
  - `client.items.name` is `"items"`.
- **Negative variant**: `client.nonexistent` — TypeScript shows an error.

### TV-TYPE-003: Explicit DatafnSchema annotation still compiles

- **Vector ID**: TV-TYPE-003
- **Description**: Backward-compatible explicit annotation widens the type.
- **Input**:
  ```typescript
  const schema: DatafnSchema = defineSchema({
    resources: [{ name: "todos", version: 1, fields: [] }],
  });
  ```
- **Expected output** (compile-time):
  - No TypeScript error.
  - `typeof schema` is `DatafnSchema` (widened — user's choice).
  - `ResourceNames<typeof schema>` is `string`.
- **Negative variant**: N/A.

---

## Svelte Integration

### TV-SVELTE-001: toSvelteStore with direct signal

- **Vector ID**: TV-SVELTE-001
- **Description**: `toSvelteStore(signal)` wraps a LiveSignal with metadata.
- **Input**:
  ```typescript
  const signal = client.task.signal({ select: ["*"] });
  const store = toSvelteStore(signal);

  let storeValue: any;
  const unsub = store.subscribe((v) => { storeValue = v; });
  ```
- **Expected output**:
  - `storeValue` has shape `{ data: ..., loading: boolean, error: ..., refreshing: boolean }`.
  - After data loads: `storeValue.data` contains query results, `storeValue.loading` is `false`.
  - After `switchContext()`: `storeValue.data` updates to new client's data.
  - After `unsub()`: store cleans up (no memory leaks).
- **Negative variant**: `toSvelteStore({} as any)` — should not crash but may produce `{ data: undefined, ... }`.

### TV-SVELTE-002: toSvelteStore factory overload still works

- **Vector ID**: TV-SVELTE-002
- **Description**: Existing factory-pattern API is preserved.
- **Input**:
  ```typescript
  const clientRef = { subscribe: client.subscribeClient.bind(client) };
  const store = toSvelteStore(clientRef, (c: any) =>
    c.table("task").signal({ select: ["*"] })
  );
  ```
- **Expected output**:
  - Store functions identically to before (creates/destroys signals on client change).
  - TypeScript compiles without errors.
- **Negative variant**: N/A.

---

## Todo App

### TV-APP-001: Todo app signal declarations are clean

- **Vector ID**: TV-APP-001
- **Description**: Todo app signal declarations use the new clean API.
- **Input** (expected code in App.svelte):
  ```typescript
  import { client } from "./lib/datafn";
  import { toSvelteStore } from "@datafn/svelte";

  const allTodosStore = toSvelteStore(
    client.todos.signal({ sort: ["-createdAt"], select: ["*", "tags.*"] })
  );
  ```
- **Expected output**:
  - No `clientRef` variable.
  - No `(c as any)` casts.
  - No factory function `(c) => ...`.
  - TypeScript compiles without errors.
  - Signal survives `switchMode()` / `switchContext()`.
- **Negative variant**: If `defineSchema` is not used (or schema is explicitly typed as `DatafnSchema`), `client.todos` would be a TypeScript error because `ResourceNames<DatafnSchema>` is `string`.
