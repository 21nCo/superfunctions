import { z } from "zod";

export type TimeRangeShortcut =
  | "last-15m"
  | "last-1h"
  | "last-6h"
  | "last-24h"
  | "last-7d"
  | "last-30d"
  | "today"
  | "yesterday"
  | "this-week"
  | "this-month";

export interface AbsoluteTimeRange {
  from: number;
  to: number;
}

export type TimeRange = TimeRangeShortcut | AbsoluteTimeRange | string;

export class TimeRangeParser {
  /**
   * Parse a time range to absolute timestamps
   */
  static parse(range: TimeRange): AbsoluteTimeRange {
    if (typeof range === "object" && "from" in range && "to" in range) {
      return range;
    }

    const now = Date.now();

    if (typeof range === "string") {
      // Handle shortcuts
      if (range.startsWith("last-")) {
        const duration = range.slice(5);
        const ms = this.parseDuration(duration);
        return { from: now - ms, to: now };
      }

      switch (range) {
        case "today":
          return this.getToday();
        case "yesterday":
          return this.getYesterday();
        case "this-week":
          return this.getThisWeek();
        case "this-month":
          return this.getThisMonth();
        default:
          // Try to parse as ISO date
          try {
            const timestamp = new Date(range).getTime();
            if (!isNaN(timestamp)) {
              return { from: timestamp, to: now };
            }
          } catch {}
          throw new Error(`Invalid time range: ${range}`);
      }
    }

    throw new Error(`Invalid time range format: ${range}`);
  }

  /**
   * Parse duration string to milliseconds
   */
  static parseDuration(duration: string): number {
    const match = duration.match(/^(\d+)(m|h|d|w)$/);
    if (!match) {
      throw new Error(`Invalid duration: ${duration}`);
    }

    const value = parseInt(match[1], 10);
    const unit = match[2];

    const multipliers: Record<string, number> = {
      m: 60 * 1000, // minutes
      h: 60 * 60 * 1000, // hours
      d: 24 * 60 * 60 * 1000, // days
      w: 7 * 24 * 60 * 60 * 1000, // weeks
    };

    return value * multipliers[unit];
  }

  /**
   * Get today's time range (midnight to now)
   */
  static getToday(): AbsoluteTimeRange {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return {
      from: today.getTime(),
      to: Date.now(),
    };
  }

  /**
   * Get yesterday's time range (midnight to midnight)
   */
  static getYesterday(): AbsoluteTimeRange {
    const now = new Date();
    const yesterday = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() - 1
    );
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return {
      from: yesterday.getTime(),
      to: today.getTime(),
    };
  }

  /**
   * Get this week's time range (start of week to now)
   */
  static getThisWeek(): AbsoluteTimeRange {
    const now = new Date();
    const dayOfWeek = now.getDay(); // 0 = Sunday
    const startOfWeek = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() - dayOfWeek
    );
    startOfWeek.setHours(0, 0, 0, 0);
    return {
      from: startOfWeek.getTime(),
      to: Date.now(),
    };
  }

  /**
   * Get this month's time range (start of month to now)
   */
  static getThisMonth(): AbsoluteTimeRange {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    return {
      from: startOfMonth.getTime(),
      to: Date.now(),
    };
  }

  /**
   * Get the interval duration in milliseconds
   */
  static getIntervalDuration(range: AbsoluteTimeRange): number {
    return range.to - range.from;
  }

  /**
   * Split time range into buckets
   */
  static getBuckets(
    range: AbsoluteTimeRange,
    bucketSize: number
  ): AbsoluteTimeRange[] {
    const buckets: AbsoluteTimeRange[] = [];
    let current = range.from;

    while (current < range.to) {
      const next = Math.min(current + bucketSize, range.to);
      buckets.push({ from: current, to: next });
      current = next;
    }

    return buckets;
  }

  /**
   * Check if a timestamp falls within a time range
   */
  static inRange(timestamp: number, range: AbsoluteTimeRange): boolean {
    return timestamp >= range.from && timestamp <= range.to;
  }
}
