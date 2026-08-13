import { describe, expect, it } from "vitest";
import type { AdminClient } from "@superfunctions/admin";
import {
  apiFnAdminCapability,
  apiFnAdminResources,
  createApiFnAdminClient,
  type ApiFnAdminOperationId,
} from "../index.js";
import {
  authFnAdminCapability,
  authFnAdminResources,
  createAuthFnAdminClient,
} from "../../../../authfn/admin/src/index.js";
import {
  billFnAdminCapability,
  billFnAdminResources,
  createBillFnAdminClient,
  type BillFnAdminOperationId,
} from "../../../../billfn/admin/src/index.js";
import {
  botFnAdminCapability,
  botFnAdminResources,
  createBotFnAdminClient,
} from "../../../../botfn/admin/src/index.js";
import {
  browseFnAdminCapability,
  browseFnAdminResources,
  createBrowseFnAdminClient,
} from "../../../../browsefn/admin/src/index.js";
import {
  cacheFnAdminCapability,
  cacheFnAdminResources,
  createCacheFnAdminClient,
} from "../../../../cachefn/admin/src/index.js";
import {
  catchFnAdminCapability,
  catchFnAdminResources,
  createCatchFnAdminClient,
} from "../../../../catchfn/admin/src/index.js";
import {
  ciFnAdminCapability,
  ciFnAdminResources,
  createCiFnAdminClient,
} from "../../../../cifn/admin/src/index.js";
import {
  cmsFnAdminCapability,
  cmsFnAdminResources,
  createCmsFnAdminClient,
} from "../../../../cmsfn/admin/src/index.js";
import {
  compFnAdminCapability,
  compFnAdminResources,
  createCompFnAdminClient,
} from "../../../../compfn/admin/src/index.js";
import {
  contentFnAdminCapability,
  contentFnAdminResources,
  createContentFnAdminClient,
} from "../../../../contentfn/admin/src/index.js";
import {
  dataFnAdminCapability,
  dataFnAdminResources,
  createDataFnAdminClient,
} from "../../../../datafn/admin/src/index.js";
import {
  docsFnAdminCapability,
  docsFnAdminResources,
  createDocsFnAdminClient,
} from "../../../../docsfn/admin/src/index.js";
import {
  fileFnAdminCapability,
  fileFnAdminResources,
  createFileFnAdminClient,
} from "../../../../filefn/admin/src/index.js";
import {
  flowFnAdminCapability,
  flowFnAdminResources,
  createFlowFnAdminClient,
} from "../../../../flowfn/admin/src/index.js";
import {
  hostFnAdminCapability,
  hostFnAdminResources,
  createHostFnAdminClient,
} from "../../../../hostfn/admin/src/index.js";
import {
  langFnAdminCapability,
  langFnAdminResources,
  createLangFnAdminClient,
} from "../../../../langfn/admin/src/index.js";
import {
  logFnAdminCapability,
  logFnAdminResources,
  createLogFnAdminClient,
} from "../../../../logfn/admin/src/index.js";
import {
  mailFnAdminCapability,
  mailFnAdminResources,
  createMailFnAdminClient,
} from "../../../../mailfn/admin/src/index.js";
import {
  memoryFnAdminCapability,
  memoryFnAdminResources,
  createMemoryFnAdminClient,
} from "../../../../memoryfn/admin/src/index.js";
import {
  plugFnAdminCapability,
  plugFnAdminResources,
  createPlugFnAdminClient,
} from "../../../../plugfn/admin/src/index.js";
import {
  probeFnAdminCapability,
  probeFnAdminResources,
  createProbeFnAdminClient,
} from "../../../../probefn/admin/src/index.js";
import {
  recFnAdminCapability,
  recFnAdminResources,
  createRecFnAdminClient,
} from "../../../../recfn/admin/src/index.js";
import {
  searchFnAdminCapability,
  searchFnAdminResources,
  createSearchFnAdminClient,
} from "../../../../searchfn/admin/src/index.js";
import {
  secFnAdminCapability,
  secFnAdminResources,
  createSecFnAdminClient,
} from "../../../../secfn/admin/src/index.js";
import {
  sendFnAdminCapability,
  sendFnAdminResources,
  createSendFnAdminClient,
} from "../../../../sendfn/admin/src/index.js";
import {
  testFnAdminCapability,
  testFnAdminResources,
  createTestFnAdminClient,
} from "../../../../testfn/admin/src/index.js";
import {
  userFnAdminCapability,
  userFnAdminResources,
  createUserFnAdminClient,
} from "../../../../userfn/admin/src/index.js";
import {
  watchFnAdminCapability,
  watchFnAdminResources,
  createWatchFnAdminClient,
} from "../../../../watchfn/admin/src/index.js";

const contracts = [
  [apiFnAdminCapability, apiFnAdminResources, createApiFnAdminClient],
  [authFnAdminCapability, authFnAdminResources, createAuthFnAdminClient],
  [billFnAdminCapability, billFnAdminResources, createBillFnAdminClient],
  [botFnAdminCapability, botFnAdminResources, createBotFnAdminClient],
  [browseFnAdminCapability, browseFnAdminResources, createBrowseFnAdminClient],
  [cacheFnAdminCapability, cacheFnAdminResources, createCacheFnAdminClient],
  [catchFnAdminCapability, catchFnAdminResources, createCatchFnAdminClient],
  [ciFnAdminCapability, ciFnAdminResources, createCiFnAdminClient],
  [cmsFnAdminCapability, cmsFnAdminResources, createCmsFnAdminClient],
  [compFnAdminCapability, compFnAdminResources, createCompFnAdminClient],
  [contentFnAdminCapability, contentFnAdminResources, createContentFnAdminClient],
  [dataFnAdminCapability, dataFnAdminResources, createDataFnAdminClient],
  [docsFnAdminCapability, docsFnAdminResources, createDocsFnAdminClient],
  [fileFnAdminCapability, fileFnAdminResources, createFileFnAdminClient],
  [flowFnAdminCapability, flowFnAdminResources, createFlowFnAdminClient],
  [hostFnAdminCapability, hostFnAdminResources, createHostFnAdminClient],
  [langFnAdminCapability, langFnAdminResources, createLangFnAdminClient],
  [logFnAdminCapability, logFnAdminResources, createLogFnAdminClient],
  [mailFnAdminCapability, mailFnAdminResources, createMailFnAdminClient],
  [memoryFnAdminCapability, memoryFnAdminResources, createMemoryFnAdminClient],
  [plugFnAdminCapability, plugFnAdminResources, createPlugFnAdminClient],
  [probeFnAdminCapability, probeFnAdminResources, createProbeFnAdminClient],
  [recFnAdminCapability, recFnAdminResources, createRecFnAdminClient],
  [searchFnAdminCapability, searchFnAdminResources, createSearchFnAdminClient],
  [secFnAdminCapability, secFnAdminResources, createSecFnAdminClient],
  [sendFnAdminCapability, sendFnAdminResources, createSendFnAdminClient],
  [testFnAdminCapability, testFnAdminResources, createTestFnAdminClient],
  [userFnAdminCapability, userFnAdminResources, createUserFnAdminClient],
  [watchFnAdminCapability, watchFnAdminResources, createWatchFnAdminClient],
] as const;

type ApiClientOperationId = Parameters<
  ReturnType<typeof createApiFnAdminClient>["invoke"]
>[0];
type ApiClientIsNarrow = string extends ApiClientOperationId
  ? false
  : ApiClientOperationId extends ApiFnAdminOperationId
    ? ApiFnAdminOperationId extends ApiClientOperationId
      ? true
      : false
    : false;
type BillFnIdsAcceptedByApiClient = BillFnAdminOperationId extends ApiClientOperationId
  ? true
  : false;

// These constants make widening or cross-function leakage a TypeScript error.
const apiClientIsNarrow: ApiClientIsNarrow = true;
const billFnIdsAreRejected: BillFnIdsAcceptedByApiClient extends false
  ? true
  : false = true;

describe("Superfunctions admin ecosystem contract", () => {
  it("publishes truthful resource metadata and a scoped client for every function", () => {
    const transport = {} as AdminClient;

    expect(contracts).toHaveLength(29);
    for (const [capability, _declaredResources, createClient] of contracts) {
      expect(createClient(transport).manifest).toBe(capability);
      if (capability.availability === "unavailable" || capability.availability === "folded") {
        expect(capability.resources).toEqual([]);
        expect(capability.operations).toEqual([]);
      } else {
        expect(capability.resources?.length).toBeGreaterThan(0);
        expect(capability.operations.length).toBeGreaterThan(0);
      }
    }
  });

  it("keeps representative operation identifiers function-scoped", () => {
    expect(apiClientIsNarrow).toBe(true);
    expect(billFnIdsAreRejected).toBe(true);
  });
});
