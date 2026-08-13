import {
  createAdminCapabilityAdapter,
  createCapabilityAdminClient,
  defineAdminCapability,
  type AdminClient,
} from "@superfunctions/admin";

export type HostFnAdminOperationId = never;
export const hostFnAdminResources = [] as const;
export const hostFnAdminActions = [] as const;

export const hostFnAdminCapability = defineAdminCapability({
  schemaVersion: "1.0",
  id: "hostfn",
  displayName: "HostFn",
  version: "1.0.0",
  description: "HostFn administration is unavailable until HostFn exposes a reusable deployment control-plane service.",
  category: "infrastructure",
  availability: "unavailable",
  unavailableReason: "HostFn currently exposes CLI and command primitives, not a canonical reusable server/operator API for deployments, domains, traffic, or secrets.",
  scopeLevels: ["organization", "workspace", "project", "environment"],
  dependencies: [],
  resources: hostFnAdminResources,
  navigation: [],
  operations: [],
});

export function createHostFnAdminClient(adminClient: AdminClient) {
  return createCapabilityAdminClient(hostFnAdminCapability, adminClient);
}

export function createHostFnAdminAdapter() {
  return createAdminCapabilityAdapter(hostFnAdminCapability, {});
}

export const adminCapability = hostFnAdminCapability;
export const createAdminAdapter = createHostFnAdminAdapter;
