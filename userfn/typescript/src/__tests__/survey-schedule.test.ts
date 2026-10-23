import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SurveyEngine } from '../core/surveys';
import { SegmentEvaluator } from '../core/segments';
import type { Survey } from '../types';

const vectors = JSON.parse(readFileSync(new URL('../../../python/tests/fixtures/survey-schedule.json', import.meta.url), 'utf8'));
describe('shared survey schedule vectors', () => {
  for (const vector of vectors) it(vector.name, () => {
    const engine = new SurveyEngine(new SegmentEvaluator(), () => vector.now);
    const survey: Survey = { id: 'scheduled', enabled: true, questions: [], triggers: [{ type: 'event' }], ...(vector.schedule === undefined ? {} : { schedule: vector.schedule }) };
    if (vector.invalid) expect(() => engine.setSurveys([survey])).toThrow('Invalid survey schedule');
    else {
      engine.setSurveys([survey]);
      expect(engine.getEligibleSurveys('event', '', { id: 'u', traits: {} }).length > 0).toBe(vector.expected);
    }
  });
});
