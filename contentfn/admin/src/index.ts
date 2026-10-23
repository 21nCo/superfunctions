import {
  createAdminCapabilityAdapter,
  createCapabilityAdminClient,
  defineAdminCapability,
  type AdminClient,
} from "@superfunctions/admin";

export type ContentFnAdminOperationId = never;
export const contentFnAdminResources = [] as const;
export const contentFnAdminActions = [] as const;

export const contentFnAdminCapability = defineAdminCapability({
  schemaVersion: "1.0",
  id: "contentfn",
  displayName: "ContentFn",
  version: "1.0.0",
  description: "ContentFn administration is owned and exposed by CmsFn's real ContentFnServer-backed module.",
  category: "content",
  availability: "folded",
  scopeLevels: ["organization", "workspace", "project", "environment"],
  owner: { moduleId: "cmsfn", mountPath: "/modules/cmsfn/contentfn" },
  dependencies: ["cmsfn"],
  resources: contentFnAdminResources,
  navigation: [],
  operations: [],
});

export function createContentFnAdminClient(adminClient: AdminClient) {
  return createCapabilityAdminClient(contentFnAdminCapability, adminClient);
}

export function createContentFnAdminAdapter() {
  return createAdminCapabilityAdapter(contentFnAdminCapability, {});
}

export const adminCapability = contentFnAdminCapability;
export const createAdminAdapter = createContentFnAdminAdapter;
