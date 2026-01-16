import { describe, it, expect, beforeEach } from 'vitest';
import { SurveyEngine } from '../core/surveys';
import { SegmentEvaluator } from '../core/segments';
import { Survey } from '../types';

const SURVEYS: Survey[] = [
  {
    id: 'nps-1',
    enabled: true,
    title: 'How likely are you to recommend us?',
    triggers: [{ type: 'url_match', pattern: '/dashboard' }],
    questions: [
      { id: 'q1', type: 'nps', title: 'Score', min: 0, max: 10 }
    ],
    caps: { global: 1 }
  }
];

describe('SurveyEngine', () => {
  let engine: SurveyEngine;
  let segments: SegmentEvaluator;

  beforeEach(() => {
    segments = new SegmentEvaluator();
    engine = new SurveyEngine(segments);
    engine.setSurveys(SURVEYS);
  });

  it('matches eligible survey', () => {
    const user = { id: 'u1', traits: {} };
    const eligible = engine.getEligibleSurveys('url_match', '/dashboard', user);
    expect(eligible).toHaveLength(1);
    expect(eligible[0].id).toBe('nps-1');
  });

  it('respects global caps', () => {
    const user = { id: 'u1', traits: {} };
    // Simulate previous response
    engine.trackResponse({ surveyId: 'nps-1', answers: [], submittedAt: Date.now() });

    const eligible = engine.getEligibleSurveys('url_match', '/dashboard', user);
    expect(eligible).toHaveLength(0);
  });
});
