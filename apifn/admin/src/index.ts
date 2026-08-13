import {
  createAdminCapabilityAdapter,
  createCapabilityAdminClient,
  defineAdminCapability,
  type AdminClient,
} from "@superfunctions/admin";

export type ApiFnAdminOperationId = never;
export const apiFnAdminResources = [] as const;
export const apiFnAdminActions = [] as const;

export const apiFnAdminCapability = defineAdminCapability({
  schemaVersion: "1.0",
  id: "apifn",
  displayName: "ApiFn",
  version: "1.0.0",
  description: "ApiFn administration is unavailable until ApiFn owns a persistent operator service for specs, environments, deployments, and credentials.",
  category: "developer-tools",
  availability: "unavailable",
  unavailableReason: "ApiFn currently provides router, OpenAPI, validation, and diff primitives but no canonical persistent operator store/service.",
  scopeLevels: ["organization", "workspace", "project", "environment"],
  dependencies: [],
  resources: apiFnAdminResources,
  navigation: [],
  operations: [],
});

export function createApiFnAdminClient(adminClient: AdminClient) {
  return createCapabilityAdminClient(apiFnAdminCapability, adminClient);
}

export function createApiFnAdminAdapter() {
  return createAdminCapabilityAdapter(apiFnAdminCapability, {});
}

export const adminCapability = apiFnAdminCapability;
export const createAdminAdapter = createApiFnAdminAdapter;
