import { canonicalJson, jsonEqual } from '../utils/json';
import { Segment, SegmentRule, UserTraits, Operator } from '../types';

export class SegmentEvaluator {
  private segments: Map<string, Segment> = new Map();

  constructor(segments: Segment[] = []) {
    segments.forEach(s => this.segments.set(s.id, s));
  }

  setSegments(segments: Segment[]) {
    this.segments = new Map(segments.map(segment => [segment.id, segment]));
  }

  evaluate(segmentId: string, traits: UserTraits): boolean {
    const segment = this.segments.get(segmentId);
    if (!segment) {
      // If segment is missing, fail closed (false)
      // or should we log a warning?
      return false;
    }
    return this.matchesSegment(segment, traits);
  }

  matchesSegment(segment: Segment, traits: UserTraits): boolean {
    if (!segment.rules || segment.rules.length === 0) {
      return true; // Empty segment matches everyone? Or no-one? Usually everyone if used as a filter.
    }

    const matchType = segment.matchType || 'all';

    if (matchType === 'any') {
      return segment.rules.some(rule => this.matchesRule(rule, traits));
    } else {
      return segment.rules.every(rule => this.matchesRule(rule, traits));
    }
  }

  matchesRule(rule: SegmentRule, traits: UserTraits): boolean {
    if (!traits || typeof traits !== 'object' || Array.isArray(traits) || ![Object.prototype, null].includes(Object.getPrototypeOf(traits))) return false;
    // Trait fields are literal own keys. Do not evaluate inherited properties/getters.
    const descriptor = Object.getOwnPropertyDescriptor(traits, rule.field);
    if (descriptor && !('value' in descriptor)) return false;
    const traitValue = descriptor?.value;
    const { operator, value } = rule;
    const present = traitValue !== undefined && traitValue !== null;
    if (operator === 'exists') return present;
    if (operator === 'does_not_exist') return !present;
    if (!present) return false;
    try {
      switch (operator) {
        case 'equals': return jsonEqual(traitValue, value);
        case 'does_not_equal': return !jsonEqual(traitValue, value);
        case 'in':
        case 'not_in': {
          if (!Array.isArray(value)) return false;
          canonicalJson(traitValue); canonicalJson(value);
          const found = value.some(candidate => jsonEqual(traitValue, candidate));
          return operator === 'in' ? found : !found;
        }
        case 'contains':
        case 'does_not_contain':
        case 'startsWith':
        case 'regex': {
          if (typeof traitValue !== 'string' || typeof value !== 'string') return false;
          if (operator === 'contains') return traitValue.includes(value);
          if (operator === 'does_not_contain') return !traitValue.includes(value);
          if (operator === 'startsWith') return traitValue.startsWith(value);
          return new RegExp(value).test(traitValue);
        }
        case 'gt': case 'gte': case 'lt': case 'lte': {
          const left = finiteNumber(traitValue), right = finiteNumber(value);
          if (left === undefined || right === undefined) return false;
          if (operator === 'gt') return left > right;
          if (operator === 'gte') return left >= right;
          if (operator === 'lt') return left < right;
          return left <= right;
        }
        default: return false;
      }
    } catch { return false; }
  }
}

/** Numeric traits may be finite numbers or decimal strings, never booleans/arrays. */
function finiteNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/^[ \t\r\n\f\v]+|[ \t\r\n\f\v]+$/g, '');
  if (!/^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/.test(text)) return undefined;
  const result = Number(text);
  return Number.isFinite(result) ? result : undefined;
}
