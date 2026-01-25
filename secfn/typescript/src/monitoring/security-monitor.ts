import type { SecurityEvent, EventQuery, SecurityMetrics, TimeRange, SecurityEventType, Severity, SecurityAnomaly } from '../types/index.js';
import type { IndexedDBStorage } from '../storage/indexeddb-storage.js';
import { generateId } from '../utils/helpers.js';

export interface MonitoringConfig {
  storage: IndexedDBStorage;
  retention?: number;
  anomalyDetection?: {
    enabled: boolean;
    sensitivity: number;
  };
}

export interface LogEventOptions {
  type: SecurityEventType;
  severity: Severity;
  userId?: string;
  ip: string;
  userAgent?: string;
  resource?: string;
  action?: string;
  metadata?: Record<string, unknown>;
}

export interface ResolveEventOptions {
  resolvedBy: string;
  notes?: string;
}

export class SecurityMonitor {
  private storage: IndexedDBStorage;
  private retention: number;
  private anomalyDetection: { enabled: boolean; sensitivity: number };

  constructor(config: MonitoringConfig) {
    this.storage = config.storage;
    this.retention = config.retention || 90 * 24 * 60 * 60 * 1000;
    this.anomalyDetection = config.anomalyDetection || {
      enabled: false,
      sensitivity: 0.8,
    };
  }

  async logEvent(options: LogEventOptions): Promise<string> {
    const event: SecurityEvent = {
      id: generateId('event'),
      timestamp: Date.now(),
      type: options.type,
      severity: options.severity,
      userId: options.userId,
      ip: options.ip,
      userAgent: options.userAgent,
      resource: options.resource,
      action: options.action,
      metadata: options.metadata || {},
      resolved: false,
    };

    await this.storage.logSecurityEvent(event);

    return event.id;
  }

  async queryEvents(query: EventQuery): Promise<SecurityEvent[]> {
    return await this.storage.queryEvents(query);
  }

  async getEvent(id: string): Promise<SecurityEvent | null> {
    const events = await this.storage.queryEvents({ limit: 1 });
    return events.find(e => e.id === id) || null;
  }

  async resolveEvent(id: string, options: ResolveEventOptions): Promise<void> {
    const events = await this.storage.queryEvents({});
    const event = events.find(e => e.id === id);

    if (!event) {
      throw new Error(`Event ${id} not found`);
    }

    event.resolved = true;
    event.resolvedAt = Date.now();
    event.resolvedBy = options.resolvedBy;
    event.notes = options.notes;

    await this.storage.logSecurityEvent(event);
  }

  async getMetrics(range: TimeRange): Promise<SecurityMetrics> {
    const metrics = await this.storage.getMetrics(range);

    if (this.anomalyDetection.enabled) {
      const events = await this.storage.queryEvents({
        startDate: range.start,
        endDate: range.end,
      });

      const anomalies = await this.detectAnomalies(events);
      metrics.anomalies = anomalies;
    }

    return metrics;
  }

  async getRecentEvents(limit = 100): Promise<SecurityEvent[]> {
    return await this.storage.queryEvents({ limit });
  }

  async getUnresolvedEvents(): Promise<SecurityEvent[]> {
    return await this.storage.queryEvents({ resolved: false });
  }

  async getCriticalEvents(hours = 24): Promise<SecurityEvent[]> {
    const startDate = Date.now() - hours * 60 * 60 * 1000;
    return await this.storage.queryEvents({
      severity: 'critical',
      startDate,
    });
  }

  async getEventsByUser(userId: string, limit = 100): Promise<SecurityEvent[]> {
    return await this.storage.queryEvents({
      userId,
      limit,
    });
  }

  async getEventsByIP(ip: string, limit = 100): Promise<SecurityEvent[]> {
    return await this.storage.queryEvents({
      ip,
      limit,
    });
  }

  async cleanup(): Promise<void> {
    await this.storage.cleanup(this.retention);
  }

  private async detectAnomalies(events: SecurityEvent[]): Promise<SecurityAnomaly[]> {
    const anomalies: SecurityAnomaly[] = [];

    const authFailures = events.filter(e => e.type === 'auth_failure');
    if (authFailures.length > 0) {
      const failureRate = this.calculateFailureRate(events, authFailures);
      if (failureRate > this.anomalyDetection.sensitivity) {
        anomalies.push({
          id: generateId('anomaly'),
          timestamp: Date.now(),
          type: 'spike_in_failures',
          score: failureRate,
          description: `Unusual spike in authentication failures: ${(failureRate * 100).toFixed(1)}%`,
          relatedEvents: authFailures.slice(0, 10).map(e => e.id),
        });
      }
    }

    const userActivityPatterns = this.analyzeUserActivity(events);
    for (const pattern of userActivityPatterns) {
      if (pattern.score > this.anomalyDetection.sensitivity) {
        anomalies.push({
          id: generateId('anomaly'),
          timestamp: Date.now(),
          type: 'unusual_access_pattern',
          score: pattern.score,
          description: pattern.description,
          relatedEvents: pattern.eventIds,
        });
      }
    }

    return anomalies;
  }

  private calculateFailureRate(totalEvents: SecurityEvent[], failures: SecurityEvent[]): number {
    if (totalEvents.length === 0) return 0;
    
    const authRelatedEvents = totalEvents.filter(e => 
      e.type === 'auth_failure' || 
      e.action?.includes('auth') || 
      e.action?.includes('login')
    );

    if (authRelatedEvents.length === 0) return 0;
    
    return failures.length / authRelatedEvents.length;
  }

  private analyzeUserActivity(events: SecurityEvent[]): Array<{
    score: number;
    description: string;
    eventIds: string[];
  }> {
    const patterns: Array<{
      score: number;
      description: string;
      eventIds: string[];
    }> = [];

    const userGroups = new Map<string, SecurityEvent[]>();
    for (const event of events) {
      if (!event.userId) continue;
      
      const userEvents = userGroups.get(event.userId) || [];
      userEvents.push(event);
      userGroups.set(event.userId, userEvents);
    }

    for (const [userId, userEvents] of userGroups) {
      const uniqueIPs = new Set(userEvents.map(e => e.ip));
      
      if (uniqueIPs.size > 5) {
        patterns.push({
          score: Math.min(uniqueIPs.size / 10, 1.0),
          description: `User ${userId} accessed from ${uniqueIPs.size} different IP addresses`,
          eventIds: userEvents.slice(0, 10).map(e => e.id),
        });
      }

      const timeGaps = this.detectTimeAnomalies(userEvents);
      if (timeGaps.length > 0) {
        patterns.push({
          score: 0.7,
          description: `Unusual access times detected for user ${userId}`,
          eventIds: timeGaps.map(e => e.id),
        });
      }
    }

    return patterns;
  }

  private detectTimeAnomalies(events: SecurityEvent[]): SecurityEvent[] {
    const anomalous: SecurityEvent[] = [];
    
    for (const event of events) {
      const hour = new Date(event.timestamp).getHours();
      
      if (hour >= 2 && hour <= 5) {
        anomalous.push(event);
      }
    }

    return anomalous;
  }
}
