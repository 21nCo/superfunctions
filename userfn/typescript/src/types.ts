export interface UserTraits {
  [key: string]: any;
  email?: string;
  name?: string;
  plan?: string;
  role?: string;
  createdAt?: string;
}

export interface UserIdentity {
  id: string;
  traits: UserTraits;
}

export type FlagValue = boolean | string | number | object;

export interface FlagVariation {
  id: string;
  value: FlagValue;
  name?: string;
}

export type Operator =
  | 'equals'
  | 'does_not_equal'
  | 'contains'
  | 'does_not_contain'
  | 'in'
  | 'not_in'
  | 'exists'
  | 'does_not_exist'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'regex';

export interface SegmentRule {
  id: string;
  field: string; // trait key, e.g., 'email', 'plan'
  operator: Operator;
  value?: any; // Value to compare against
}

export interface Segment {
  id: string;
  name: string;
  rules: SegmentRule[]; // Implicitly ANDed for now, or could be nested
  matchType?: 'all' | 'any'; // all rules must match vs any rule matches
}

export interface FlagRule {
  id: string;
  segmentId?: string; // Reference to a defined segment
  constraints?: SegmentRule[]; // Inline rules specific to this flag
  rolloutPercentage?: number; // 0-100
  variationId?: string; // If matched, force this variation
}

export interface FlagPrerequisite {
  key: string;
  expectedValue: FlagValue;
}

export interface FlagEnvironmentOverride {
  enabled?: boolean;
  defaultValue?: FlagValue;
  /** null clears the inherited default variation. */
  defaultVariationId?: string | null;
  /** Replaces the base ordered rule list. */
  rules?: FlagRule[];
}

export interface FlagConfig {
  key: string;
  variations: FlagVariation[];
  defaultValue: FlagValue; // Evaluated fallback when enabled; unavailable flags use the caller fallback
  defaultVariationId?: string; // Fallback variation ID
  rules: FlagRule[];
  enabled: boolean;
  prerequisites?: FlagPrerequisite[];
  environmentOverrides?: Record<string, FlagEnvironmentOverride>;
}

export interface ConfigRefreshStatus {
  running: boolean;
  consecutiveFailures: number;
  lastSuccessAt?: number;
  lastError?: string;
  nextRefreshAt?: number;
}
export interface SignedConfigOptions {
  tenantId: string;
  /** Trusted key ID to base64url Ed25519 SPKI DER public key, provisioned out of band. */
  trustedKeys: Record<string, string>;
  timeoutMs?: number;
  /** Explicit opt-in for local HTTP acceptance; use HTTPS in production. */
  allowInsecureHttp?: boolean;
}
export interface UserFnOptions {
  config?: SignedConfigOptions;
  apiKey: string;
  /** Exact, case-sensitive local flag environment; omitted means base configuration. */
  environment?: string;
  endpoint?: string;
  feedbackMaxAttempts?: number;
  feedbackTimeoutMs?: number;
  /** Optional override; otherwise endpoint/apiKey configure the HTTP service. */
  feedbackService?: FeedbackService;
  /** Local resolved values, used immediately without network access; setFlags replaces them. */
  bootstrapFlags?: Record<string, FlagValue>;
  /** Milliseconds between settled background refreshes; explicit start required. Default 30000. */
  refreshInterval?: number;
}

export interface EventProperties {
  [key: string]: any;
}

export type FeedbackCategory = 'bug' | 'feature' | 'general';
export type FeedbackStatus = 'open' | 'planned' | 'in_progress' | 'done' | 'closed';

export interface FeedbackSubmission {
  title: string;
  body: string;
  category: FeedbackCategory;
  priority?: 'low' | 'medium' | 'high';
  tags?: string[];
  productArea?: string;
  attachments?: string[]; // URLs or base64
  score?: number; // For surveys
}

export interface FeedbackItem {
  productArea?: string | null;
  tags?: string[];
  id: string;
  title: string;
  body: string;
  category: FeedbackCategory;
  status: FeedbackStatus;
  votes: number;
  viewerVote?: -1 | 0 | 1;
  createdAt: string;
}

export type MessageKind = 'banner' | 'modal' | 'tooltip' | 'inbox-item';

export interface MessageContent {
  title?: string;
  body: string;
  ctaText?: string;
  ctaUrl?: string;
  ctaAction?: 'link' | 'dismiss' | 'custom';
  imageUrl?: string;
}

export interface CampaignTrigger {
  type: 'url_match' | 'event' | 'manual';
  pattern?: string; // glob or regex for url, event name for event
}

export interface Campaign {
  id: string;
  kind: MessageKind;
  content: MessageContent;
  segmentId?: string; // Audience
  triggers: CampaignTrigger[];
  priority?: number;
  caps?: {
    global?: number; // Max times to show globally per user
    session?: number; // Max times per session
  };
  enabled: boolean;
}

export interface MessageDelivery {
  campaignId: string;
  status: 'shown' | 'dismissed' | 'clicked';
  timestamp: number;
}

export type QuestionType = 'nps' | 'csat' | 'text' | 'choice';

export interface Question {
  id: string;
  type: QuestionType;
  title: string;
  description?: string;
  choices?: { label: string; value: any }[]; // For choice/radio
  min?: number; // For NPS/CSAT (e.g. 0 or 1)
  max?: number; // For NPS/CSAT (e.g. 10 or 5)
  required?: boolean;
}

export interface Survey {
  id: string;
  title?: string;
  questions: Question[];
  segmentId?: string;
  triggers: CampaignTrigger[];
  enabled: boolean;
  caps?: {
    global?: number;
  };
}

export interface SurveyResponse {
  surveyId: string;
  answers: { questionId: string; value: any }[];
  submittedAt: number;
}


/** The service must return this only after accepting the submission for persistence. */
export interface FeedbackReceipt { id: string; accepted: true; }
export interface FeedbackSubmitOptions { idempotencyKey?: string; }
export interface FeedbackContext extends FeedbackSubmitOptions { source: 'in_app'; user: UserIdentity | null; }
export interface FeedbackService {
  list?(options?: FeedbackBoardOptions): Promise<FeedbackBoardPage>;
  vote?(id: string, direction: -1 | 0 | 1): Promise<FeedbackVote>;
  setMetadata?(id: string, patch: FeedbackMetadataPatch): Promise<FeedbackMetadataResult>;
  setStatus?(id: string, status: FeedbackStatus): Promise<FeedbackStatusResult>;
  submit(feedback: FeedbackSubmission, context: FeedbackContext): Promise<FeedbackReceipt>;
}

export interface FeedbackBoardOptions { limit?: number; after?: string; status?: FeedbackStatus; tag?: string; productArea?: string; }
export interface FeedbackBoardPage { items: FeedbackItem[]; nextCursor: string | null; }
export interface FeedbackVote { id: string; votes: number; viewerVote: -1 | 0 | 1; }
export interface FeedbackStatusResult { id: string; status: FeedbackStatus; }

export interface FeedbackMetadataPatch { tags?: string[]; productArea?: string | null; }
export interface FeedbackMetadataResult { id: string; tags: string[]; productArea: string | null; }
