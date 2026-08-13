import {
  createAdminCapabilityAdapter,
  createCapabilityAdminClient,
  defineAdminCapability,
  type AdminClient,
} from "@superfunctions/admin";

export type UserFnAdminOperationId = never;
export const userFnAdminResources = [] as const;
export const userFnAdminActions = [] as const;

export const userFnAdminCapability = defineAdminCapability({
  schemaVersion: "1.0",
  id: "userfn",
  displayName: "UserFn",
  version: "1.0.0",
  description: "UserFn administration is unavailable until UserFn owns a self-hosted authoritative backend and operator service.",
  category: "engagement",
  availability: "unavailable",
  unavailableReason: "The current UserFn package is a client/UI engine and cannot prove server-side scope or persistence ownership for administration.",
  scopeLevels: ["organization", "workspace", "project", "environment"],
  dependencies: [],
  resources: userFnAdminResources,
  navigation: [],
  operations: [],
});

export function createUserFnAdminClient(adminClient: AdminClient) {
  return createCapabilityAdminClient(userFnAdminCapability, adminClient);
}

export function createUserFnAdminAdapter() {
  return createAdminCapabilityAdapter(userFnAdminCapability, {});
}

export const adminCapability = userFnAdminCapability;
export const createAdminAdapter = createUserFnAdminAdapter;
