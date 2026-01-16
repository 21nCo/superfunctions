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

export interface FlagRule {
  id: string;
  segments: string[]; // Segment IDs
  rolloutPercentage?: number;
  variationId?: string; // If specific variation is forced
}

export interface FlagConfig {
  key: string;
  variations: FlagVariation[];
  defaultValue: FlagValue;
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

export interface ContentSlot {
  id: string;
  // ... properties for the renderer
}
