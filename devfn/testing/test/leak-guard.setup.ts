// Stops what a failed or timed-out test left running, and fails a test file that leaves a
// process running or a temp entry behind (devfn/test-support/leak-guard.mjs).
import { afterAll, afterEach, beforeEach } from "vitest";
import { guardTestFile } from "../../test-support/leak-guard.mjs";

guardTestFile({ beforeEach, afterEach, afterAll });
