import { afterEach } from "vitest";

// Most tests here are synchronous, and awaiting one only runs microtasks, so a
// file of them never lets the worker read Vitest's RPC replies. After about a
// minute of such tests the run fails with "Timeout calling onTaskUpdate" even
// though every test passed. Yielding to the event loop after each test reads them.
afterEach(() => new Promise<void>((resolve) => setImmediate(resolve)));
