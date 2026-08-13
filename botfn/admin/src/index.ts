import {
  createAdminCapabilityAdapter,
  createCapabilityAdminClient,
  defineAdminCapability,
  type AdminClient,
} from "@superfunctions/admin";

export type BotFnAdminOperationId = never;
export const botFnAdminResources = [] as const;
export const botFnAdminActions = [] as const;

export const botFnAdminCapability = defineAdminCapability({
  schemaVersion: "1.0",
  id: "botfn",
  displayName: "BotFn",
  version: "1.0.0",
  description: "BotFn administration is unavailable until BotFn owns a unified bot/channel operator service.",
  category: "communication",
  availability: "unavailable",
  unavailableReason: "BotFn has platform integrations and persistence workers, but no canonical aggregate for bots, channels, deployments, commands, and conversations.",
  scopeLevels: ["organization", "workspace", "project", "environment"],
  dependencies: [],
  resources: botFnAdminResources,
  navigation: [],
  operations: [],
});

export function createBotFnAdminClient(adminClient: AdminClient) {
  return createCapabilityAdminClient(botFnAdminCapability, adminClient);
}

export function createBotFnAdminAdapter() {
  return createAdminCapabilityAdapter(botFnAdminCapability, {});
}

export const adminCapability = botFnAdminCapability;
export const createAdminAdapter = createBotFnAdminAdapter;
