import { Segment, SegmentRule, UserTraits, Operator } from '../types';

export class SegmentEvaluator {
  private segments: Map<string, Segment> = new Map();

  constructor(segments: Segment[] = []) {
    segments.forEach(s => this.segments.set(s.id, s));
  }

  setSegments(segments: Segment[]) {
    this.segments.clear();
    segments.forEach(s => this.segments.set(s.id, s));
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
    const traitValue = traits[rule.field];
    const { operator, value } = rule;

    switch (operator) {
      case 'exists':
        return traitValue !== undefined && traitValue !== null;
      case 'does_not_exist':
        return traitValue === undefined || traitValue === null;
      
      // If trait is missing for other operators, usually evaluate to false
      // unless comparing inequality might be tricky.
      // For now, if trait is missing, we return false for most checks.
    }

    if (traitValue === undefined || traitValue === null) return false;

    switch (operator) {
      case 'equals':
        return String(traitValue) === String(value);
      case 'does_not_equal':
        return String(traitValue) !== String(value);
      case 'contains':
        return String(traitValue).includes(String(value));
      case 'does_not_contain':
        return !String(traitValue).includes(String(value));
      case 'in':
        return Array.isArray(value) && value.includes(traitValue);
      case 'not_in':
        return Array.isArray(value) && !value.includes(traitValue);
      case 'gt':
        return Number(traitValue) > Number(value);
      case 'gte':
        return Number(traitValue) >= Number(value);
      case 'lt':
        return Number(traitValue) < Number(value);
      case 'lte':
        return Number(traitValue) <= Number(value);
      case 'regex':
        try {
          const re = new RegExp(value);
          return re.test(String(traitValue));
        } catch (e) {
          return false;
        }
      default:
        return false;
    }
  }
}
