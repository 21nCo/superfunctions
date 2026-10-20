import {
  createAdminCapabilityAdapter as createKernelAdapter,
  createCapabilityAdminClient,
  defineAdminCapability,
  AdminError,
  type AdminCapabilityAdapter,
  type AdminClient,
  type AdminClientRequestOptions,
  type AdminObjectSchema,
  type AdminOperationContext,
  type AdminOperationDefinition,
  type AdminOperationRequest,
  type AdminOperationResult,
} from "@superfunctions/admin";
import {
  UserFnOperatorService,
  type Campaign,
  type FeedbackStatus,
  type FeedbackItem,
  type FlagConfig,
  type Segment,
  type Survey,
  type UserFnOperatorScope,
  type UserTraits,
  type UserIdentity,
} from "userfn/operator";

export interface PageInput {
  cursor?: string;
  limit?: number;
}
export interface IdInput {
  id: string;
}
export interface UserTraitsInput extends IdInput {
  traits: UserTraits;
}
export interface SegmentInput {
  segment: Segment;
}
export interface FlagInput {
  flag: FlagConfig;
}
export interface EnabledInput extends IdInput {
  enabled: boolean;
}
export interface CampaignInput {
  campaign: Campaign;
}
export interface SurveyInput {
  survey: Survey;
}
export interface TriageInput extends IdInput {
  status: FeedbackStatus;
}
export interface PageOutput<T = unknown> {
  items: T[];
  nextCursor: string | null;
}
export interface ItemOutput<T = unknown> {
  item: T;
}
export interface UserFnAdminOperationInputMap {
  "userfn.users.list": PageInput;
  "userfn.users.get": IdInput;
  "userfn.users.update-traits": UserTraitsInput;
  "userfn.segments.list": PageInput;
  "userfn.segments.save": SegmentInput;
  "userfn.flags.list": PageInput;
  "userfn.flags.save": FlagInput;
  "userfn.flags.set-enabled": EnabledInput;
  "userfn.campaigns.list": PageInput;
  "userfn.campaigns.save": CampaignInput;
  "userfn.campaigns.set-enabled": EnabledInput;
  "userfn.surveys.list": PageInput;
  "userfn.surveys.save": SurveyInput;
  "userfn.feedback.list": PageInput;
  "userfn.feedback.triage": TriageInput;
}
export type UserFnAdminOperationId = keyof UserFnAdminOperationInputMap;
export interface UserFnAdminOperationOutputMap {
  "userfn.users.list": PageOutput<UserIdentity>;
  "userfn.users.get": ItemOutput<UserIdentity>;
  "userfn.users.update-traits": ItemOutput<UserIdentity>;
  "userfn.segments.list": PageOutput<Segment>;
  "userfn.segments.save": ItemOutput<Segment>;
  "userfn.flags.list": PageOutput<FlagConfig>;
  "userfn.flags.save": ItemOutput<FlagConfig>;
  "userfn.flags.set-enabled": ItemOutput<FlagConfig>;
  "userfn.campaigns.list": PageOutput<Campaign>;
  "userfn.campaigns.save": ItemOutput<Campaign>;
  "userfn.campaigns.set-enabled": ItemOutput<Campaign>;
  "userfn.surveys.list": PageOutput<Survey>;
  "userfn.surveys.save": ItemOutput<Survey>;
  "userfn.feedback.list": PageOutput<FeedbackItem>;
  "userfn.feedback.triage": ItemOutput<FeedbackItem>;
}

const entity: AdminObjectSchema = {
  type: "object",
  additionalProperties: true,
};
const records = {
  users: {
    type: "object",
    properties: { id: { type: "string" }, traits: entity },
    required: ["id", "traits"],
    additionalProperties: false,
  },
  segments: {
    type: "object",
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      rules: { type: "array", items: entity },
      matchType: { type: "string" },
    },
    required: ["id", "name", "rules"],
    additionalProperties: false,
  },
  flags: {
    type: "object",
    properties: {
      key: { type: "string" },
      variations: { type: "array", items: entity },
      defaultValue: {},
      defaultVariationId: { type: "string", minLength: 1 },
      rules: { type: "array", items: entity },
      enabled: { type: "boolean" },
      prerequisites: {
        type: "array",
        items: { type: "object", properties: { key: { type: "string", minLength: 1 }, expectedValue: {} }, required: ["key", "expectedValue"], additionalProperties: false },
      },
      environmentOverrides: {
        type: "object",
        additionalProperties: {
          type: "object",
          properties: {
            enabled: { type: "boolean" }, defaultValue: {},
            defaultVariationId: { type: ["string", "null"] },
            rules: { type: "array", items: entity },
          },
          additionalProperties: false,
        },
      },
    },
    required: ["key", "variations", "defaultValue", "rules", "enabled"],
    additionalProperties: false,
  },
  campaigns: {
    type: "object",
    properties: {
      id: { type: "string" },
      kind: { type: "string" },
      content: entity,
      triggers: { type: "array", items: entity },
      priority: { type: "number" },
      enabled: { type: "boolean" },
    },
    required: ["id", "kind", "content", "triggers", "enabled"],
    additionalProperties: false,
  },
  surveys: {
    type: "object",
    properties: {
      id: { type: "string" },
      title: { type: "string" },
      questions: { type: "array", items: entity },
      triggers: { type: "array", items: entity },
      enabled: { type: "boolean" },
    },
    required: ["id", "questions", "triggers", "enabled"],
    additionalProperties: false,
  },
  feedback: {
    type: "object",
    properties: {
      id: { type: "string" },
      title: { type: "string" },
      body: { type: "string" },
      category: { type: "string" },
      status: { type: "string" },
      votes: { type: "number" },
      createdAt: { type: "string" },
    },
    required: [
      "id",
      "title",
      "body",
      "category",
      "status",
      "votes",
      "createdAt",
    ],
    additionalProperties: false,
  },
} as const satisfies Record<string, AdminObjectSchema>;
const pageOutput = (record: AdminObjectSchema): AdminObjectSchema => ({
  type: "object",
  properties: {
    items: { type: "array", items: record },
    nextCursor: { type: ["string", "null"] },
  },
  required: ["items", "nextCursor"],
  additionalProperties: false,
});
const itemOutput = (record: AdminObjectSchema): AdminObjectSchema => ({
  type: "object",
  properties: { item: record },
  required: ["item"],
  additionalProperties: false,
});
const pageInput: AdminObjectSchema = {
  type: "object",
  properties: {
    cursor: { type: "string" },
    limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
  },
  additionalProperties: false,
};
const idInput: AdminObjectSchema = {
  type: "object",
  properties: { id: { type: "string", minLength: 1 } },
  required: ["id"],
  additionalProperties: false,
};
const wrapper = (
  name: string,
  record: keyof typeof records,
): AdminObjectSchema => ({
  type: "object",
  properties: { [name]: records[record] },
  required: [name],
  additionalProperties: false,
});
const enabledInput: AdminObjectSchema = {
  type: "object",
  properties: {
    id: { type: "string", minLength: 1 },
    enabled: { type: "boolean" },
  },
  required: ["id", "enabled"],
  additionalProperties: false,
};
const traitsInput: AdminObjectSchema = {
  type: "object",
  properties: { id: { type: "string", minLength: 1 }, traits: entity },
  required: ["id", "traits"],
  additionalProperties: false,
};
const triageInput: AdminObjectSchema = {
  type: "object",
  properties: {
    id: { type: "string", minLength: 1 },
    status: {
      type: "string",
      enum: ["open", "planned", "in_progress", "done", "closed"],
    },
  },
  required: ["id", "status"],
  additionalProperties: false,
};
export const userFnAdminResources = [
  {
    id: "users",
    label: "Users",
    description: "User identities and traits in the active environment.",
    icon: "userfn:users",
    risk: "sensitive",
    minimumScope: "environment",
    idField: "id",
    displayFields: ["id", "traits"],
    searchableFields: ["id", "traits.email", "traits.name"],
    filterableFields: ["traits.plan", "traits.role"],
    sortableFields: ["id"],
    sensitiveFields: ["traits.email"],
  },
  {
    id: "segments",
    label: "Segments",
    description: "Audience segmentation rules.",
    icon: "userfn:segments",
    risk: "standard",
    minimumScope: "environment",
    idField: "id",
    displayFields: ["id", "name", "matchType"],
    searchableFields: ["id", "name"],
    filterableFields: ["matchType"],
    sortableFields: ["name"],
    sensitiveFields: [],
  },
  {
    id: "flags",
    label: "Flags",
    description: "Feature flags and targeting rules.",
    icon: "userfn:flags",
    risk: "standard",
    minimumScope: "environment",
    idField: "key",
    displayFields: ["key", "enabled", "defaultValue"],
    searchableFields: ["key"],
    filterableFields: ["enabled"],
    sortableFields: ["key"],
    sensitiveFields: [],
  },
  {
    id: "campaigns",
    label: "Campaigns",
    description: "In-product messaging campaigns.",
    icon: "userfn:campaigns",
    risk: "standard",
    minimumScope: "environment",
    idField: "id",
    displayFields: ["id", "kind", "enabled", "priority"],
    searchableFields: ["id", "content.title"],
    filterableFields: ["kind", "enabled"],
    sortableFields: ["priority"],
    sensitiveFields: [],
  },
  {
    id: "surveys",
    label: "Surveys",
    description: "Targeted product surveys.",
    icon: "userfn:surveys",
    risk: "standard",
    minimumScope: "environment",
    idField: "id",
    displayFields: ["id", "title", "enabled"],
    searchableFields: ["id", "title"],
    filterableFields: ["enabled"],
    sortableFields: ["title"],
    sensitiveFields: [],
  },
  {
    id: "feedback",
    label: "Feedback",
    description: "User feedback triage queue.",
    icon: "userfn:feedback",
    risk: "sensitive",
    minimumScope: "environment",
    idField: "id",
    displayFields: ["id", "title", "category", "status", "votes", "createdAt"],
    searchableFields: ["id", "title", "body"],
    filterableFields: ["category", "status"],
    sortableFields: ["createdAt", "votes"],
    sensitiveFields: ["body"],
  },
] as const;
function read(
  id: UserFnAdminOperationId,
  resource: keyof typeof records,
  detail = false,
): AdminOperationDefinition {
  return {
    id,
    title: id.split(".").at(-1)!,
    description: `Read UserFn ${resource} in the active environment.`,
    inputSchema: detail ? idInput : pageInput,
    outputSchema: detail
      ? itemOutput(records[resource])
      : pageOutput(records[resource]),
    route: {
      method: "GET",
      path: `/resources/${resource}${detail ? "/:id" : ""}`,
    },
    permission: `userfn.${resource}.read`,
    minimumScope: "environment",
    safety: {
      classification: "read",
      idempotent: true,
      requiresConfirmation: false,
      audit:
        resource === "users" || resource === "feedback"
          ? "required"
          : "optional",
    },
    pagination: detail
      ? undefined
      : { mode: "cursor", defaultLimit: 50, maxLimit: 100 },
    mcp: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    redaction:
      resource === "users"
        ? { outputFields: ["traits"] }
        : resource === "feedback"
          ? { outputFields: ["body"] }
          : undefined,
    target: detail
      ? { resource, idInput: "id" }
      : { resource, collection: true },
  };
}
function write(
  id: UserFnAdminOperationId,
  resource: keyof typeof records,
  schema: AdminObjectSchema,
  collection = false,
): AdminOperationDefinition {
  return {
    id,
    title: id.split(".").at(-1)!,
    description: `Update UserFn ${resource} in the active environment.`,
    inputSchema: schema,
    outputSchema: itemOutput(records[resource]),
    route: {
      method: "POST",
      path: `/resources/${resource}/actions/${id.split(".").at(-1)}`,
    },
    permission: id,
    minimumScope: "environment",
    safety: {
      classification: "write",
      idempotent: true,
      requiresConfirmation: true,
      confirmation: {
        risk: "high",
        method: "explicit",
        reason: `Authorize ${id}.`,
      },
      audit: "required",
    },
    mcp: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    redaction:
      resource === "users" ? { inputFields: ["traits"] } : undefined,
    target: collection
      ? { resource, collection: true }
      : { resource, idInput: "id" },
  };
}
const operations = [
  read("userfn.users.list", "users"),
  read("userfn.users.get", "users", true),
  write("userfn.users.update-traits", "users", traitsInput),
  read("userfn.segments.list", "segments"),
  write(
    "userfn.segments.save",
    "segments",
    wrapper("segment", "segments"),
    true,
  ),
  read("userfn.flags.list", "flags"),
  write("userfn.flags.save", "flags", wrapper("flag", "flags"), true),
  write("userfn.flags.set-enabled", "flags", enabledInput),
  read("userfn.campaigns.list", "campaigns"),
  write(
    "userfn.campaigns.save",
    "campaigns",
    wrapper("campaign", "campaigns"),
    true,
  ),
  write("userfn.campaigns.set-enabled", "campaigns", enabledInput),
  read("userfn.surveys.list", "surveys"),
  write("userfn.surveys.save", "surveys", wrapper("survey", "surveys"), true),
  read("userfn.feedback.list", "feedback"),
  write("userfn.feedback.triage", "feedback", triageInput),
] as const;
export const userFnAdminCapability = defineAdminCapability({
  schemaVersion: "1.0",
  id: "userfn",
  displayName: "UserFn",
  version: "1.1.0",
  description:
    "Self-hosted user engagement, targeting, messaging, surveys, and feedback administration.",
  category: "engagement",
  availability: "required-product",
  scopeLevels: ["installation", "workspace", "project", "environment"],
  dependencies: [],
  resources: userFnAdminResources,
  navigation: [
    {
      id: "userfn",
      label: "UserFn",
      path: "/modules/userfn",
      icon: "userfn",
      description: "Operate UserFn engagement configuration.",
      order: 160,
    },
  ],
  operations,
});
type CoreClient = ReturnType<
  typeof createCapabilityAdminClient<typeof userFnAdminCapability>
>;
type UserResult<K extends UserFnAdminOperationId> = Promise<
  AdminOperationResult<UserFnAdminOperationOutputMap[K]>
>;
export interface UserFnAdminClient extends CoreClient {
  users: {
    list(
      input?: PageInput,
      options?: AdminClientRequestOptions,
    ): UserResult<"userfn.users.list">;
    get(
      input: IdInput,
      options?: AdminClientRequestOptions,
    ): UserResult<"userfn.users.get">;
    updateTraits(
      input: UserTraitsInput,
      options?: AdminClientRequestOptions,
    ): UserResult<"userfn.users.update-traits">;
  };
  segments: {
    list(
      input?: PageInput,
      options?: AdminClientRequestOptions,
    ): UserResult<"userfn.segments.list">;
    save(
      input: SegmentInput,
      options?: AdminClientRequestOptions,
    ): UserResult<"userfn.segments.save">;
  };
  flags: {
    list(
      input?: PageInput,
      options?: AdminClientRequestOptions,
    ): UserResult<"userfn.flags.list">;
    save(
      input: FlagInput,
      options?: AdminClientRequestOptions,
    ): UserResult<"userfn.flags.save">;
    setEnabled(
      input: EnabledInput,
      options?: AdminClientRequestOptions,
    ): UserResult<"userfn.flags.set-enabled">;
  };
  campaigns: {
    list(
      input?: PageInput,
      options?: AdminClientRequestOptions,
    ): UserResult<"userfn.campaigns.list">;
    save(
      input: CampaignInput,
      options?: AdminClientRequestOptions,
    ): UserResult<"userfn.campaigns.save">;
    setEnabled(
      input: EnabledInput,
      options?: AdminClientRequestOptions,
    ): UserResult<"userfn.campaigns.set-enabled">;
  };
  surveys: {
    list(
      input?: PageInput,
      options?: AdminClientRequestOptions,
    ): UserResult<"userfn.surveys.list">;
    save(
      input: SurveyInput,
      options?: AdminClientRequestOptions,
    ): UserResult<"userfn.surveys.save">;
  };
  feedback: {
    list(
      input?: PageInput,
      options?: AdminClientRequestOptions,
    ): UserResult<"userfn.feedback.list">;
    triage(
      input: TriageInput,
      options?: AdminClientRequestOptions,
    ): UserResult<"userfn.feedback.triage">;
  };
}
export function createUserFnAdminClient(
  adminClient: AdminClient,
): UserFnAdminClient {
  const client = createCapabilityAdminClient(
    userFnAdminCapability,
    adminClient,
  );
  const call = (
    id: UserFnAdminOperationId,
    input: object,
    options?: AdminClientRequestOptions,
  ) => client.invoke(id, input, options);
  return Object.assign(client, {
    users: {
      list: (i: PageInput = {}, o?: AdminClientRequestOptions) =>
        call("userfn.users.list", i, o),
      get: (i: IdInput, o?: AdminClientRequestOptions) =>
        call("userfn.users.get", i, o),
      updateTraits: (i: UserTraitsInput, o?: AdminClientRequestOptions) =>
        call("userfn.users.update-traits", i, o),
    },
    segments: {
      list: (i: PageInput = {}, o?: AdminClientRequestOptions) =>
        call("userfn.segments.list", i, o),
      save: (i: SegmentInput, o?: AdminClientRequestOptions) =>
        call("userfn.segments.save", i, o),
    },
    flags: {
      list: (i: PageInput = {}, o?: AdminClientRequestOptions) =>
        call("userfn.flags.list", i, o),
      save: (i: FlagInput, o?: AdminClientRequestOptions) =>
        call("userfn.flags.save", i, o),
      setEnabled: (i: EnabledInput, o?: AdminClientRequestOptions) =>
        call("userfn.flags.set-enabled", i, o),
    },
    campaigns: {
      list: (i: PageInput = {}, o?: AdminClientRequestOptions) =>
        call("userfn.campaigns.list", i, o),
      save: (i: CampaignInput, o?: AdminClientRequestOptions) =>
        call("userfn.campaigns.save", i, o),
      setEnabled: (i: EnabledInput, o?: AdminClientRequestOptions) =>
        call("userfn.campaigns.set-enabled", i, o),
    },
    surveys: {
      list: (i: PageInput = {}, o?: AdminClientRequestOptions) =>
        call("userfn.surveys.list", i, o),
      save: (i: SurveyInput, o?: AdminClientRequestOptions) =>
        call("userfn.surveys.save", i, o),
    },
    feedback: {
      list: (i: PageInput = {}, o?: AdminClientRequestOptions) =>
        call("userfn.feedback.list", i, o),
      triage: (i: TriageInput, o?: AdminClientRequestOptions) =>
        call("userfn.feedback.triage", i, o),
    },
  }) as unknown as UserFnAdminClient;
}
function scope(context: AdminOperationContext): UserFnOperatorScope {
  const installationId =
    context.scope.installationId ?? context.scope.organizationId;
  const { workspaceId, projectId, environmentId } = context.scope;
  if (!installationId || !workspaceId || !projectId || !environmentId)
    throw new AdminError(
      "invalid_argument",
      "UserFn requires installation, workspace, project, and environment scope.",
    );
  return { installationId, workspaceId, projectId, environmentId };
}
function pageResult<T>(
  items: T[],
  input: PageInput,
  context: AdminOperationContext,
): PageOutput<T> {
  const active = scope(context);
  const marker = [
    active.installationId,
    active.workspaceId,
    active.projectId,
    active.environmentId,
  ].join("/");
  let offset = 0;
  if (input.cursor) {
    try {
      const decoded = JSON.parse(atob(input.cursor)) as {
        marker: string;
        offset: number;
      };
      if (
        decoded.marker !== marker ||
        !Number.isSafeInteger(decoded.offset) ||
        decoded.offset < 0
      )
        throw new Error();
      offset = decoded.offset;
    } catch {
      throw new AdminError(
        "invalid_argument",
        "UserFn cursor does not belong to the active scope.",
      );
    }
  }
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
  const pageItems = items.slice(offset, offset + limit);
  const nextOffset = offset + pageItems.length;
  return {
    items: pageItems,
    nextCursor:
      nextOffset < items.length
        ? btoa(JSON.stringify({ marker, offset: nextOffset }))
        : null,
  };
}
const missing = (name: string, id: string): never => {
  throw new AdminError("not_found", `UserFn ${name} not found: ${id}`);
};
export interface UserFnAdminService {
  listUsers(
    input: PageInput,
    context: AdminOperationContext,
  ): Promise<PageOutput<UserIdentity>>;
  getUser(
    input: IdInput,
    context: AdminOperationContext,
  ): Promise<ItemOutput<UserIdentity>>;
  updateTraits(
    input: UserTraitsInput,
    context: AdminOperationContext,
  ): Promise<ItemOutput<UserIdentity>>;
  listSegments(
    input: PageInput,
    context: AdminOperationContext,
  ): Promise<PageOutput<Segment>>;
  saveSegment(
    input: SegmentInput,
    context: AdminOperationContext,
  ): Promise<ItemOutput<Segment>>;
  listFlags(
    input: PageInput,
    context: AdminOperationContext,
  ): Promise<PageOutput<FlagConfig>>;
  saveFlag(
    input: FlagInput,
    context: AdminOperationContext,
  ): Promise<ItemOutput<FlagConfig>>;
  setFlagEnabled(
    input: EnabledInput,
    context: AdminOperationContext,
  ): Promise<ItemOutput<FlagConfig>>;
  listCampaigns(
    input: PageInput,
    context: AdminOperationContext,
  ): Promise<PageOutput<Campaign>>;
  saveCampaign(
    input: CampaignInput,
    context: AdminOperationContext,
  ): Promise<ItemOutput<Campaign>>;
  setCampaignEnabled(
    input: EnabledInput,
    context: AdminOperationContext,
  ): Promise<ItemOutput<Campaign>>;
  listSurveys(
    input: PageInput,
    context: AdminOperationContext,
  ): Promise<PageOutput<Survey>>;
  saveSurvey(
    input: SurveyInput,
    context: AdminOperationContext,
  ): Promise<ItemOutput<Survey>>;
  listFeedback(
    input: PageInput,
    context: AdminOperationContext,
  ): Promise<PageOutput<FeedbackItem>>;
  triageFeedback(
    input: TriageInput,
    context: AdminOperationContext,
  ): Promise<ItemOutput<FeedbackItem>>;
}
export function createUserFnOperatorAdminService(
  operator: UserFnOperatorService,
): UserFnAdminService {
  return {
    listUsers: async (i, c) =>
      pageResult(await operator.listUsers(scope(c)), i, c),
    getUser: async (i: IdInput, c) => ({
      item: (await operator.getUser(scope(c), i.id)) ?? missing("user", i.id),
    }),
    updateTraits: async (i: UserTraitsInput, c) => ({
      item: await operator.updateTraits(scope(c), i.id, i.traits),
    }),
    listSegments: async (i, c) =>
      pageResult(await operator.listSegments(scope(c)), i, c),
    saveSegment: async (i: SegmentInput, c) => ({
      item: await operator.saveSegment(scope(c), i.segment),
    }),
    listFlags: async (i, c) =>
      pageResult(await operator.listFlags(scope(c)), i, c),
    saveFlag: async (i: FlagInput, c) => ({
      item: await operator.saveFlag(scope(c), i.flag),
    }),
    setFlagEnabled: async (i: EnabledInput, c) => ({
      item: await operator.setFlagEnabled(scope(c), i.id, i.enabled),
    }),
    listCampaigns: async (i, c) =>
      pageResult(await operator.listCampaigns(scope(c)), i, c),
    saveCampaign: async (i: CampaignInput, c) => ({
      item: await operator.saveCampaign(scope(c), i.campaign),
    }),
    setCampaignEnabled: async (i: EnabledInput, c) => ({
      item: await operator.setCampaignEnabled(scope(c), i.id, i.enabled),
    }),
    listSurveys: async (i, c) =>
      pageResult(await operator.listSurveys(scope(c)), i, c),
    saveSurvey: async (i: SurveyInput, c) => ({
      item: await operator.saveSurvey(scope(c), i.survey),
    }),
    listFeedback: async (i, c) =>
      pageResult(await operator.listFeedback(scope(c)), i, c),
    triageFeedback: async (i: TriageInput, c) => ({
      item: await operator.triageFeedback(scope(c), i.id, i.status),
    }),
  };
}
function bind(
  method: (input: never, context: AdminOperationContext) => Promise<unknown>,
) {
  return ({ input, context }: AdminOperationRequest) =>
    method(input as never, context);
}
export function createUserFnAdminAdapter(
  service: UserFnAdminService,
): AdminCapabilityAdapter<typeof userFnAdminCapability> {
  return createKernelAdapter(userFnAdminCapability, {
    "userfn.users.list": bind(service.listUsers as never),
    "userfn.users.get": bind(service.getUser as never),
    "userfn.users.update-traits": bind(service.updateTraits as never),
    "userfn.segments.list": bind(service.listSegments as never),
    "userfn.segments.save": bind(service.saveSegment as never),
    "userfn.flags.list": bind(service.listFlags as never),
    "userfn.flags.save": bind(service.saveFlag as never),
    "userfn.flags.set-enabled": bind(service.setFlagEnabled as never),
    "userfn.campaigns.list": bind(service.listCampaigns as never),
    "userfn.campaigns.save": bind(service.saveCampaign as never),
    "userfn.campaigns.set-enabled": bind(service.setCampaignEnabled as never),
    "userfn.surveys.list": bind(service.listSurveys as never),
    "userfn.surveys.save": bind(service.saveSurvey as never),
    "userfn.feedback.list": bind(service.listFeedback as never),
    "userfn.feedback.triage": bind(service.triageFeedback as never),
  });
}
export const adminCapability = userFnAdminCapability;
export const createAdminAdapter = createUserFnAdminAdapter;
