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
    engine.trackResponse({ surveyId: 'nps-1', answers: [], submittedAt: Date.now() }, user);

    const eligible = engine.getEligibleSurveys('url_match', '/dashboard', user);
    expect(eligible).toHaveLength(0);
  });
});


it('isolates local response caps by identity and retains them when returning to that identity', () => {
  const engine = new SurveyEngine(new SegmentEvaluator()); engine.setSurveys(SURVEYS);
  const alice = { id: 'alice', traits: {} }, bob = { id: 'bob', traits: {} };
  engine.trackResponse({ surveyId: 'nps-1', answers: [], submittedAt: Date.now() }, alice);
  expect(engine.getEligibleSurveys('url_match', '/dashboard', alice)).toHaveLength(0);
  expect(engine.getEligibleSurveys('url_match', '/dashboard', bob)).toHaveLength(1);
  engine.setSurveys(SURVEYS);
  expect(engine.getEligibleSurveys('url_match', '/dashboard', alice)).toHaveLength(0);
});

it('treats zero and malformed runtime caps as denial and omission as one response per identity', () => {
  const engine = new SurveyEngine(new SegmentEvaluator()); const user = { id: 'u', traits: {} };
  for (const cap of [0, -1, 0.5, NaN, Infinity, '1', null]) {
    engine.setSurveys([{ ...SURVEYS[0], caps: { global: cap as number } }]);
    expect(engine.getEligibleSurveys('url_match', '/dashboard', user)).toHaveLength(0);
  }
  engine.setSurveys([{ ...SURVEYS[0], caps: undefined }]);
  expect(engine.getEligibleSurveys('url_match', '/dashboard', user)).toHaveLength(1);
  engine.trackResponse({ surveyId: 'nps-1', answers: [], submittedAt: Date.now() }, user);
  expect(engine.getEligibleSurveys('url_match', '/dashboard', user)).toHaveLength(0);
});
