import { afterEach } from "vitest";

// fromOpenAPI conversions are synchronous, and a test's awaits settle as
// microtasks, so a file of them can keep the worker from reading the
// runner's RPC replies for longer than the RPC timeout. Returning to the
// event loop after every test lets those replies through.
afterEach(() => new Promise<void>((resolve) => setImmediate(resolve)));
