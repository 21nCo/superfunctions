import {
  createAdminCapabilityAdapter,
  createCapabilityAdminClient,
  defineAdminCapability,
  type AdminClient,
} from "@superfunctions/admin";

export type DocsFnAdminOperationId = never;
export const docsFnAdminResources = [] as const;
export const docsFnAdminActions = [] as const;

export const docsFnAdminCapability = defineAdminCapability({
  schemaVersion: "1.0",
  id: "docsfn",
  displayName: "DocsFn",
  version: "1.0.0",
  description: "DocsFn administration is unavailable until DocsFn owns a persisted site/build/deployment operator service.",
  category: "developer-tools",
  availability: "unavailable",
  unavailableReason: "DocsFn currently provides compiler, navigation, search, and provider primitives but no canonical site CRUD or deployment control plane.",
  scopeLevels: ["organization", "workspace", "project", "environment"],
  dependencies: [],
  resources: docsFnAdminResources,
  navigation: [],
  operations: [],
});

export function createDocsFnAdminClient(adminClient: AdminClient) {
  return createCapabilityAdminClient(docsFnAdminCapability, adminClient);
}

export function createDocsFnAdminAdapter() {
  return createAdminCapabilityAdapter(docsFnAdminCapability, {});
}

export const adminCapability = docsFnAdminCapability;
export const createAdminAdapter = createDocsFnAdminAdapter;
