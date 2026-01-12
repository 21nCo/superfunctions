export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type Environment = 'development' | 'staging' | 'production';

export interface StorageConfig {
  type: 'indexeddb' | 'file' | 'db';
  dbName?: string;
  path?: string;
  adapter?: any;
  retentionDays?: number;
}

export interface SecretPattern {
  name: string;
  pattern: RegExp;
  entropy?: number;
  description: string;
  severity: Severity;
}

export interface SecretScanResult {
  id: string;
  timestamp: number;
  file: string;
  line: number;
  column: number;
  pattern: string;
  match: string;
  redactedMatch: string;
  severity: Severity;
  entropy: number;
  context: string;
  resolved: boolean;
  falsePositive: boolean;
  metadata?: Record<string, unknown>;
}

export interface Secret {
  id: string;
  key: string;
  value: string;
  encrypted: boolean;
  version: number;
  tags: string[];
  environment?: Environment;
  expiresAt?: number;
  rotateEvery?: number;
  lastRotated?: number;
  lastAccessed?: number;
  accessCount: number;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface SecretAccess {
  id: string;
  secretId: string;
  userId: string;
  action: 'read' | 'write' | 'delete' | 'rotate';
  timestamp: number;
  ip?: string;
  userAgent?: string;
}

export interface Role {
  id: string;
  name: string;
  description: string;
  permissions: string[];
  inherits?: string[];
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface Permission {
  id: string;
  resource: string;
  action: string;
  conditions?: PolicyCondition[];
}

export interface UserRole {
  userId: string;
  roleId: string;
  resourceIds?: string[];
  expiresAt?: number;
  assignedAt: number;
}

export interface PolicyCondition {
  field: string;
  operator: 'eq' | 'ne' | 'in' | 'nin' | 'gt' | 'lt' | 'contains';
  value: unknown;
}

export interface AccessRequest {
  userId: string;
  action: string;
  resourceId?: string;
  context?: Record<string, unknown>;
}

export interface RateLimitRule {
  id?: string;
  name?: string;
  type?: 'global' | 'perUser' | 'perIP' | 'perEndpoint';
  requests: number;
  window: number;
  blockDuration?: number;
  endpoints?: string[];
}

export interface RateLimitEntry {
  key: string;
  count: number;
  resetAt: number;
  blocked: boolean;
  blockedUntil?: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
  retryAfter?: number;
  limit?: number;
}

export interface RateLimitViolation {
  id: string;
  timestamp: number;
  key: string;
  ip: string;
  userId?: string;
  endpoint: string;
  requestCount: number;
  limit: number;
  window: number;
  blocked: boolean;
}

export type SecurityEventType =
  | 'auth_failure'
  | 'rate_limit_exceeded'
  | 'unauthorized_access'
  | 'secret_accessed'
  | 'permission_denied'
  | 'suspicious_activity'
  | 'secret_exposed'
  | 'policy_violation';

export interface SecurityEvent {
  id: string;
  timestamp: number;
  type: SecurityEventType;
  severity: Severity;
  userId?: string;
  ip: string;
  userAgent?: string;
  resource?: string;
  action?: string;
  metadata: Record<string, unknown>;
  resolved: boolean;
  resolvedAt?: number;
  resolvedBy?: string;
  notes?: string;
}

export interface SecurityMetrics {
  timeRange: { start: number; end: number };
  totalEvents: number;
  eventsByType: Record<string, number>;
  eventsBySeverity: Record<string, number>;
  topIPs: Array<{ ip: string; count: number }>;
  topUsers: Array<{ userId: string; count: number }>;
  anomalies?: SecurityAnomaly[];
}

export type AnomalyType =
  | 'unusual_access_pattern'
  | 'geographic_anomaly'
  | 'spike_in_failures'
  | 'new_endpoint_access'
  | 'unusual_time';

export interface SecurityAnomaly {
  id: string;
  timestamp: number;
  type: AnomalyType;
  score: number;
  description: string;
  relatedEvents: string[];
  userId?: string;
  ip?: string;
}

export interface EventQuery {
  type?: SecurityEventType | SecurityEventType[];
  severity?: Severity | Severity[];
  userId?: string;
  ip?: string;
  startDate?: number;
  endDate?: number;
  resolved?: boolean;
  limit?: number;
  offset?: number;
}

export interface TimeRange {
  start: number;
  end: number;
}
