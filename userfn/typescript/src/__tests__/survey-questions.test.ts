import { describe, expect, it } from 'vitest';
import { surveyQuestionVisible, surveyScaleBounds, validateSurveyBranches } from '../core/survey-questions';
import type { Question } from '../types';

const root: Question = { id: 'root', type: 'choice', title: 'Root' };
describe('conditional survey contract', () => {
  it('matches primitive answers without coercion and treats missing answers as hidden', () => {
    const branch: Question = { id: 'branch', type: 'text', title: 'Details', when: { questionId: 'root', equals: false } };
    validateSurveyBranches([root, branch]);
    expect(surveyQuestionVisible(branch, [])).toBe(false);
    expect(surveyQuestionVisible(branch, [{ questionId: 'root', value: 'false' }])).toBe(false);
    expect(surveyQuestionVisible(branch, [{ questionId: 'root', value: false }])).toBe(true);
  });
  it('rejects missing, forward, self, duplicate and malformed branch definitions', () => {
    for (const questionId of ['missing', 'next', 'branch']) {
      expect(() => validateSurveyBranches([root, { id: 'branch', type: 'text', title: '', when: { questionId, equals: true } }, { id: 'next', type: 'text', title: '' }])).toThrow();
    }
    expect(() => validateSurveyBranches([root, root])).toThrow();
    for (const equals of [null, {}, [], NaN, Infinity]) expect(() => validateSurveyBranches([root, { id: 'branch', type: 'text', title: '', when: { questionId: 'root', equals: equals as boolean } }])).toThrow();
  });
  it('defines NPS, CSAT, CES and custom scale defaults and overrides', () => {
    for (const [type, min, max] of [['nps', 0, 10], ['csat', 1, 5], ['ces', 1, 7], ['scale', 1, 5]] as const) {
      expect(surveyScaleBounds({ ...root, type })).toEqual({ min, max });
      expect(surveyScaleBounds({ ...root, type, min: -2, max: 2 })).toEqual({ min: -2, max: 2 });
    }
  });
});
