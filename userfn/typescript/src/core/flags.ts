import { FlagConfig, FlagValue, UserIdentity, FlagRule } from '../types';
import { SegmentEvaluator } from './segments';
import { getBucket } from '../utils/hash';

export type FlagEvaluation = { value: FlagValue; variationId: string | null; ruleId: string | null; reason: 'rule' | 'default_variation' | 'default_value' | 'unavailable' | 'bootstrap' };
type Evaluation = { available: false } | ({ available: true } & FlagEvaluation);
const unavailable: Evaluation = { available: false };
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);

export class FlagEvaluator {
  private flags: Map<string, FlagConfig> = new Map();

  constructor(initialFlags: FlagConfig[] = [], private segments: SegmentEvaluator, private environment?: string) {
    if (environment !== undefined && (typeof environment !== 'string' || !environment.trim())) throw new TypeError('Flag environment must be a non-empty string');
    this.setFlags(initialFlags);
  }

  setFlags(flags: FlagConfig[]) {
    validateFlagDefinitions(flags);
    // Snapshot only after validation; a failed replacement preserves previous configuration.
    let snapshot: FlagConfig[];
    try { snapshot = JSON.parse(JSON.stringify(flags)); } catch { throw new TypeError('Flag configuration must be JSON serializable'); }
    validateFlagDefinitions(snapshot);
    this.flags = new Map(snapshot.map(flag => [flag.key, flag]));
  }

  getFlag(key: string, defaultValue: FlagValue, user?: UserIdentity | null): FlagValue {
    return this.evaluate(key, defaultValue, user).value;
  }

  evaluate(key: string, defaultValue: FlagValue, user?: UserIdentity | null): FlagEvaluation {
    const resolved = new Map<string, Evaluation>();
    const active = new Set<string>();
    const stack: Array<{ key: string; flag?: FlagConfig; next: number }> = [{ key, next: 0 }];
    const finish = (result: Evaluation) => {
      const frame = stack.pop()!; active.delete(frame.key); resolved.set(frame.key, result);
    };
    // Iterative DFS avoids call-stack limits; results exist only for this user/environment call.
    while (stack.length) {
      const frame = stack[stack.length - 1];
      if (!frame.flag) {
        const base = this.flags.get(frame.key);
        if (!base || !base.enabled) { finish(unavailable); continue; }
        const override = this.environment !== undefined && base.environmentOverrides && own(base.environmentOverrides, this.environment)
          ? base.environmentOverrides[this.environment] : undefined;
        const effective = override ? { ...base, ...override, defaultVariationId: override.defaultVariationId === null ? undefined : override.defaultVariationId ?? base.defaultVariationId } : base;
        if (!effective.enabled) { finish(unavailable); continue; }
        frame.flag = effective;
        active.add(frame.key);
      }
      const prerequisites = frame.flag.prerequisites ?? [];
      if (frame.next < prerequisites.length) {
        const prerequisite = prerequisites[frame.next];
        if (active.has(prerequisite.key)) { finish(unavailable); continue; }
        const result = resolved.get(prerequisite.key);
        if (!result) { stack.push({ key: prerequisite.key, next: 0 }); continue; }
        if (!result.available || canonicalJson(result.value) !== canonicalJson(prerequisite.expectedValue)) { finish(unavailable); continue; }
        frame.next++;
      } else finish({ available: true, ...this.evaluateRules(frame.flag, user) });
    }
    const result = resolved.get(key)!;
    if (!result.available) return { value: defaultValue, variationId: null, ruleId: null, reason: 'unavailable' };
    // Returned JSON objects must not let callers mutate later prerequisite decisions.
    return { value: result.value !== null && typeof result.value === 'object' ? JSON.parse(JSON.stringify(result.value)) : result.value, variationId: result.variationId, ruleId: result.ruleId, reason: result.reason };
  }

  private evaluateRules(flag: FlagConfig, user?: UserIdentity | null): FlagEvaluation {
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
        if (variation) return { value: variation.value, variationId: variation.id, ruleId: rule.id, reason: 'rule' };
      }
      
      // If rule matches but no variation ID, skip it or return default.
      continue;
    }

    // Fallback
    if (flag.defaultVariationId) {
      const variation = flag.variations.find(v => v.id === flag.defaultVariationId);
      if (variation) return { value: variation.value, variationId: variation.id, ruleId: null, reason: 'default_variation' };
    }

    return { value: flag.defaultValue, variationId: null, ruleId: null, reason: 'default_value' };
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
/** JSON structural equality: objects ignore key order; bool, number and string stay distinct. */
function canonicalJson(value: unknown, ancestors = new Set<object>()): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value !== 'object' || ancestors.has(value)) throw new TypeError('Flag values must be finite, acyclic JSON values');
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new TypeError('Flag values must use plain JSON objects');
  const keys = Object.keys(value);
  if (Reflect.ownKeys(value).length !== keys.length + (Array.isArray(value) ? 1 : 0) || keys.some(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    return descriptor.get !== undefined || descriptor.set !== undefined;
  })) throw new TypeError('Flag values must use enumerable JSON data properties');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (keys.length !== value.length) throw new TypeError('Flag arrays must not contain holes or extra properties');
      for (let index = 0; index < value.length; index++) if (!own(value, String(index))) throw new TypeError('Flag arrays must not contain holes');
      return '[' + value.map(item => canonicalJson(item, ancestors)).join(',') + ']';
    }
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJson((value as Record<string, unknown>)[key], ancestors)).join(',') + '}';
  } finally { ancestors.delete(value); }
}

// Inspect descriptors before reading values so accessors/toJSON cannot alter the snapshot.
// Optional undefined data properties remain supported and are omitted during serialization.
function validateConfigurationData(value: unknown, ancestors = new Set<object>()): void {
  if (value === undefined || value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || ancestors.has(value)) throw new TypeError('Flag configuration must contain finite acyclic JSON data');
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new TypeError('Flag configuration must contain plain objects');
  ancestors.add(value);
  try {
    for (const key of Reflect.ownKeys(value)) {
      if (Array.isArray(value) && key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (typeof key !== 'string' || !descriptor.enumerable || !('value' in descriptor)) throw new TypeError('Flag configuration must contain enumerable data properties');
      validateConfigurationData(descriptor.value, ancestors);
    }
  } finally { ancestors.delete(value); }
}

export function validateFlagDefinitions(flags: FlagConfig[]): void {
  validateConfigurationData(flags);
  const fail = (message: string): never => { throw new TypeError('Invalid flag configuration: ' + message); };
  const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
  const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
  const operators = new Set(['equals', 'does_not_equal', 'contains', 'does_not_contain', 'in', 'not_in', 'exists', 'does_not_exist', 'gt', 'gte', 'lt', 'lte', 'regex']);
  if (!Array.isArray(flags)) fail('flags must be an array');
  const keys = new Set<string>();
  for (const flag of flags) {
    if (!object(flag) || !text(flag.key) || keys.has(flag.key)) fail('flag keys must be unique non-empty strings');
    keys.add(flag.key);
    if (typeof flag.enabled !== 'boolean' || !own(flag, 'defaultValue')) fail('enabled and defaultValue are required');
    canonicalJson(flag.defaultValue);
    if (!Array.isArray(flag.variations)) fail('variations must be an array');
    const variations = new Set<string>();
    for (const variation of flag.variations) {
      if (!object(variation) || !text(variation.id) || variations.has(variation.id) || !own(variation, 'value')) fail('invalid or duplicate variation');
      canonicalJson(variation.value); variations.add(variation.id);
    }
    const variationId = (id: unknown) => { if (!text(id) || !variations.has(id)) fail('unknown variation ID'); };
    if (flag.defaultVariationId !== undefined) variationId(flag.defaultVariationId);
    const rules = (items: unknown) => {
      if (!Array.isArray(items)) fail('rules must be an array');
      for (const rule of items as FlagRule[]) {
        if (!object(rule) || !text(rule.id)) fail('invalid rule');
        if (rule.segmentId !== undefined && !text(rule.segmentId)) fail('invalid segment ID');
        if (rule.variationId !== undefined) variationId(rule.variationId);
        if (rule.rolloutPercentage !== undefined && (typeof rule.rolloutPercentage !== 'number' || !Number.isFinite(rule.rolloutPercentage) || rule.rolloutPercentage < 0 || rule.rolloutPercentage > 100)) fail('rollout must be between 0 and 100');
        if (rule.constraints !== undefined) {
          if (!Array.isArray(rule.constraints)) fail('constraints must be an array');
          for (const constraint of rule.constraints) {
            if (!object(constraint) || !text(constraint.id) || !text(constraint.field) || !operators.has(constraint.operator)) fail('invalid constraint');
            if (constraint.value !== undefined) canonicalJson(constraint.value);
          }
        }
      }
    };
    rules(flag.rules);
    if (flag.prerequisites !== undefined) {
      if (!Array.isArray(flag.prerequisites)) fail('prerequisites must be an array');
      for (const prerequisite of flag.prerequisites) {
        if (!object(prerequisite) || !text(prerequisite.key) || !own(prerequisite, 'expectedValue') || Object.keys(prerequisite).some(key => key !== 'key' && key !== 'expectedValue')) fail('invalid prerequisite');
        canonicalJson(prerequisite.expectedValue);
      }
    }
    if (flag.environmentOverrides !== undefined) {
      if (!object(flag.environmentOverrides)) fail('environmentOverrides must be an object');
      for (const [environment, override] of Object.entries(flag.environmentOverrides)) {
        if (!environment.trim() || !object(override) || Object.keys(override).some(key => !['enabled', 'defaultValue', 'defaultVariationId', 'rules'].includes(key))) fail('invalid environment override');
        if (override.enabled !== undefined && typeof override.enabled !== 'boolean') fail('override enabled must be boolean');
        if (override.defaultValue !== undefined) canonicalJson(override.defaultValue);
        if (override.defaultVariationId !== undefined && override.defaultVariationId !== null) variationId(override.defaultVariationId);
        if (override.rules !== undefined) rules(override.rules);
      }
    }
  }
}
