import { FlagConfig, FlagValue, UserIdentity, FlagRule } from '../types';
import { SegmentEvaluator } from './segments';
import { getBucket } from '../utils/hash';

export class FlagEvaluator {
  private flags: Map<string, FlagConfig> = new Map();
  private segments: SegmentEvaluator;

  constructor(initialFlags: FlagConfig[] = [], segmentEvaluator: SegmentEvaluator) {
    this.flags = new Map(initialFlags.map(f => [f.key, f]));
    this.segments = segmentEvaluator;
  }

  setFlags(flags: FlagConfig[]) {
    this.flags.clear();
    flags.forEach(flag => this.flags.set(flag.key, flag));
  }

  getFlag(key: string, defaultValue: FlagValue, user?: UserIdentity | null): FlagValue {
    const flag = this.flags.get(key);

    if (!flag) {
      return defaultValue;
    }

    if (!flag.enabled) {
      return defaultValue;
    }

    // Evaluate rules in order
    for (const rule of flag.rules) {
      // 1. Check constraints (Segment & Inline)
      if (!this.matchesConstraints(rule, user)) {
        continue;
      }

      // 2. Check Rollout
      if (rule.rolloutPercentage !== undefined && rule.rolloutPercentage !== null) {
        // If 100%, skip hash check
        if (rule.rolloutPercentage < 100) {
           if (!user) continue; // Anon users fail partial rollouts? Or fall through.
           const bucket = getBucket(flag.key, user.id);
           if (bucket >= rule.rolloutPercentage) {
             continue; // User is in the upper bucket, so this rule doesn't apply to them.
           }
        }
      }

      // 3. Return Variation
      if (rule.variationId) {
        const variation = flag.variations.find(v => v.id === rule.variationId);
        if (variation) return variation.value;
      }
      
      // If rule matches but no variation ID, skip it or return default.
      continue;
    }

    // Fallback
    if (flag.defaultVariationId) {
      const variation = flag.variations.find(v => v.id === flag.defaultVariationId);
      if (variation) return variation.value;
    }

    return flag.defaultValue;
  }

  private matchesConstraints(rule: FlagRule, user?: UserIdentity | null): boolean {
    if (!user) {
      // Anonymous matching: allowed only if no constraints defined
      if (rule.segmentId || (rule.constraints && rule.constraints.length > 0)) {
        return false;
      }
      return true;
    }

    // Check Segment
    if (rule.segmentId) {
      const matchesSegment = this.segments.evaluate(rule.segmentId, user.traits);
      if (!matchesSegment) return false;
    }

    // Check Inline Constraints
    if (rule.constraints && rule.constraints.length > 0) {
      const matchesConstraints = rule.constraints.every(c => 
        this.segments.matchesRule(c, user.traits)
      );
      if (!matchesConstraints) return false;
    }

    return true;
  }
}