import {
  createAdminCapabilityAdapter,
  createCapabilityAdminClient,
  defineAdminCapability,
  type AdminClient,
} from "@superfunctions/admin";

export type LangFnAdminOperationId = never;
export const langFnAdminResources = [] as const;
export const langFnAdminActions = [] as const;

export const langFnAdminCapability = defineAdminCapability({
  schemaVersion: "1.0",
  id: "langfn",
  displayName: "LangFn",
  version: "1.0.0",
  description: "LangFn administration is unavailable until LangFn owns a provider, prompt, dataset, evaluation, and usage registry.",
  category: "intelligence",
  availability: "unavailable",
  unavailableReason: "LangFn exposes execution/model/tracing primitives but no canonical persistent operator registry for the advertised control-plane resources.",
  scopeLevels: ["organization", "workspace", "project", "environment"],
  dependencies: [],
  resources: langFnAdminResources,
  navigation: [],
  operations: [],
});

export function createLangFnAdminClient(adminClient: AdminClient) {
  return createCapabilityAdminClient(langFnAdminCapability, adminClient);
}

export function createLangFnAdminAdapter() {
  return createAdminCapabilityAdapter(langFnAdminCapability, {});
}

export const adminCapability = langFnAdminCapability;
export const createAdminAdapter = createLangFnAdminAdapter;
