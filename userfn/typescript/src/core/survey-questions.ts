import type { Question, SurveyResponse } from '../types';

/** Forward-only references keep conditional forms deterministic and cycle-free. */
export function validateSurveyBranches(questions: Question[]): void {
  const prior = new Set<string>();
  for (const question of questions) {
    if (!question || typeof question.id !== 'string' || prior.has(question.id)) throw new Error('Invalid survey question identity');
    if (question.when !== undefined) {
      const when = question.when;
      if (!when || typeof when !== 'object' || Object.keys(when).some(key => !['questionId', 'equals'].includes(key)) ||
          !prior.has(when.questionId) || !['string', 'number', 'boolean'].includes(typeof when.equals) ||
          (typeof when.equals === 'number' && !Number.isFinite(when.equals))) throw new Error('Invalid survey branch');
    }
    prior.add(question.id);
  }
}

export function surveyQuestionVisible(question: Question, answers: SurveyResponse['answers']): boolean {
  return question.when === undefined || answers.some(answer => answer.questionId === question.when!.questionId && answer.value === question.when!.equals);
}

export function surveyScaleBounds(question: Question): { min: number; max: number } {
  return { min: question.min ?? (question.type === 'nps' ? 0 : 1), max: question.max ?? (question.type === 'nps' ? 10 : question.type === 'ces' ? 7 : 5) };
}
