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

export interface FlagConfig {
  key: string;
  variations: FlagVariation[];
  defaultValue: FlagValue; // Fallback value if no rules match or flag disabled
  defaultVariationId?: string; // Fallback variation ID
  rules: FlagRule[];
  enabled: boolean;
}

export interface UserFnOptions {
  apiKey: string;
  endpoint?: string;
  bootstrapFlags?: Record<string, FlagValue>;
  refreshInterval?: number;
}

export interface EventProperties {
  [key: string]: any;
}

export interface FeedbackSubmission {
  title: string;
  body: string;
  tags?: string[];
  attachments?: string[]; // URLs or base64
  score?: number; // For surveys
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
