import { validateFlagDefinitions } from './core/flags';
export { validateFlagDefinitions } from './core/flags';
import type {
  Campaign,
  FlagConfig,
  Segment,
  Survey,
  UserIdentity,
  UserTraits,
  FeedbackItem,
  FeedbackStatus,
} from "./types";
export type {
  Campaign,
  FlagConfig,
  Segment,
  Survey,
  UserIdentity,
  UserTraits,
  FeedbackItem,
  FeedbackStatus,
} from "./types";

export interface UserFnOperatorScope {
  installationId: string;
  workspaceId: string;
  projectId: string;
  environmentId: string;
}
export interface UserFnScoped<T> {
  scope: UserFnOperatorScope;
  value: T;
}
export interface UserFnOperatorStore {
  listUsers(scope: UserFnOperatorScope): Promise<UserIdentity[]>;
  getUser(
    scope: UserFnOperatorScope,
    id: string,
  ): Promise<UserIdentity | undefined>;
  putUser(scope: UserFnOperatorScope, user: UserIdentity): Promise<void>;
  listSegments(scope: UserFnOperatorScope): Promise<Segment[]>;
  putSegment(scope: UserFnOperatorScope, segment: Segment): Promise<void>;
  listFlags(scope: UserFnOperatorScope): Promise<FlagConfig[]>;
  putFlag(scope: UserFnOperatorScope, flag: FlagConfig): Promise<void>;
  listCampaigns(scope: UserFnOperatorScope): Promise<Campaign[]>;
  putCampaign(scope: UserFnOperatorScope, campaign: Campaign): Promise<void>;
  listSurveys(scope: UserFnOperatorScope): Promise<Survey[]>;
  putSurvey(scope: UserFnOperatorScope, survey: Survey): Promise<void>;
  listFeedback(scope: UserFnOperatorScope): Promise<FeedbackItem[]>;
  putFeedback(
    scope: UserFnOperatorScope,
    feedback: FeedbackItem,
  ): Promise<void>;
}

function key(scope: UserFnOperatorScope) {
  return JSON.stringify([
    scope.installationId,
    scope.workspaceId,
    scope.projectId,
    scope.environmentId,
  ]);
}
function bucket<T>(
  map: Map<string, Map<string, T>>,
  scope: UserFnOperatorScope,
): Map<string, T> {
  const id = key(scope);
  let value = map.get(id);
  if (!value) {
    value = new Map();
    map.set(id, value);
  }
  return value;
}

/** Self-hosted reference persistence; replace with a durable store in multi-process deployments. */
export class MemoryUserFnOperatorStore implements UserFnOperatorStore {
  private users = new Map<string, Map<string, UserIdentity>>();
  private segments = new Map<string, Map<string, Segment>>();
  private flags = new Map<string, Map<string, FlagConfig>>();
  private campaigns = new Map<string, Map<string, Campaign>>();
  private surveys = new Map<string, Map<string, Survey>>();
  private feedback = new Map<string, Map<string, FeedbackItem>>();
  async listUsers(scope: UserFnOperatorScope) {
    return [...bucket(this.users, scope).values()].map((v) =>
      structuredClone(v),
    );
  }
  async getUser(scope: UserFnOperatorScope, id: string) {
    const value = bucket(this.users, scope).get(id);
    return value && structuredClone(value);
  }
  async putUser(scope: UserFnOperatorScope, value: UserIdentity) {
    bucket(this.users, scope).set(value.id, structuredClone(value));
  }
  async listSegments(scope: UserFnOperatorScope) {
    return [...bucket(this.segments, scope).values()].map((v) =>
      structuredClone(v),
    );
  }
  async putSegment(scope: UserFnOperatorScope, value: Segment) {
    bucket(this.segments, scope).set(value.id, structuredClone(value));
  }
  async listFlags(scope: UserFnOperatorScope) {
    return [...bucket(this.flags, scope).values()].map((v) =>
      structuredClone(v),
    );
  }
  async putFlag(scope: UserFnOperatorScope, value: FlagConfig) {
    bucket(this.flags, scope).set(value.key, structuredClone(value));
  }
  async listCampaigns(scope: UserFnOperatorScope) {
    return [...bucket(this.campaigns, scope).values()].map((v) =>
      structuredClone(v),
    );
  }
  async putCampaign(scope: UserFnOperatorScope, value: Campaign) {
    bucket(this.campaigns, scope).set(value.id, structuredClone(value));
  }
  async listSurveys(scope: UserFnOperatorScope) {
    return [...bucket(this.surveys, scope).values()].map((v) =>
      structuredClone(v),
    );
  }
  async putSurvey(scope: UserFnOperatorScope, value: Survey) {
    bucket(this.surveys, scope).set(value.id, structuredClone(value));
  }
  async listFeedback(scope: UserFnOperatorScope) {
    return [...bucket(this.feedback, scope).values()].map((v) =>
      structuredClone(v),
    );
  }
  async putFeedback(scope: UserFnOperatorScope, value: FeedbackItem) {
    bucket(this.feedback, scope).set(value.id, structuredClone(value));
  }
}

export class UserFnOperatorService {
  constructor(private readonly store: UserFnOperatorStore) {}
  listUsers(scope: UserFnOperatorScope) {
    return this.store.listUsers(scope);
  }
  getUser(scope: UserFnOperatorScope, id: string) {
    return this.store.getUser(scope, id);
  }
  async updateTraits(
    scope: UserFnOperatorScope,
    id: string,
    traits: UserTraits,
  ) {
    const current = await this.store.getUser(scope, id);
    if (!current) throw new Error(`UserFn user not found: ${id}`);
    const user = { ...current, traits: { ...current.traits, ...traits } };
    await this.store.putUser(scope, user);
    return user;
  }
  listSegments(scope: UserFnOperatorScope) {
    return this.store.listSegments(scope);
  }
  async saveSegment(scope: UserFnOperatorScope, segment: Segment) {
    await this.store.putSegment(scope, segment);
    return segment;
  }
  listFlags(scope: UserFnOperatorScope) {
    return this.store.listFlags(scope);
  }
  async saveFlag(scope: UserFnOperatorScope, flag: FlagConfig) {
    validateFlagDefinitions([flag]);
    await this.store.putFlag(scope, flag);
    return flag;
  }
  async setFlagEnabled(
    scope: UserFnOperatorScope,
    key: string,
    enabled: boolean,
  ) {
    const flag = (await this.store.listFlags(scope)).find(
      (item) => item.key === key,
    );
    if (!flag) throw new Error(`UserFn flag not found: ${key}`);
    const value = { ...flag, enabled };
    validateFlagDefinitions([value]);
    await this.store.putFlag(scope, value);
    return value;
  }
  listCampaigns(scope: UserFnOperatorScope) {
    return this.store.listCampaigns(scope);
  }
  async saveCampaign(scope: UserFnOperatorScope, campaign: Campaign) {
    await this.store.putCampaign(scope, campaign);
    return campaign;
  }
  async setCampaignEnabled(
    scope: UserFnOperatorScope,
    id: string,
    enabled: boolean,
  ) {
    const campaign = (await this.store.listCampaigns(scope)).find(
      (item) => item.id === id,
    );
    if (!campaign) throw new Error(`UserFn campaign not found: ${id}`);
    const value = { ...campaign, enabled };
    await this.store.putCampaign(scope, value);
    return value;
  }
  listSurveys(scope: UserFnOperatorScope) {
    return this.store.listSurveys(scope);
  }
  async saveSurvey(scope: UserFnOperatorScope, survey: Survey) {
    await this.store.putSurvey(scope, survey);
    return survey;
  }
  listFeedback(scope: UserFnOperatorScope) {
    return this.store.listFeedback(scope);
  }
  async triageFeedback(
    scope: UserFnOperatorScope,
    id: string,
    status: FeedbackStatus,
  ) {
    const feedback = (await this.store.listFeedback(scope)).find(
      (item) => item.id === id,
    );
    if (!feedback) throw new Error(`UserFn feedback not found: ${id}`);
    const value = { ...feedback, status };
    await this.store.putFeedback(scope, value);
    return value;
  }
}
