import { Survey, CampaignTrigger, UserIdentity, SurveyResponse } from '../types';
import { SegmentEvaluator } from './segments';

export class SurveyEngine {
  private surveys: Map<string, Survey> = new Map();
  private responses = new Map<string, Map<string, SurveyResponse[]>>(); // userId -> surveyId -> responses
  private segments: SegmentEvaluator;

  constructor(segments: SegmentEvaluator) {
    this.segments = segments;
  }

  setSurveys(surveys: Survey[]) {
    this.surveys.clear();
    surveys.forEach(s => this.surveys.set(s.id, s));
  }

  getEligibleSurveys(
    triggerType: CampaignTrigger['type'],
    triggerContext: string,
    user: UserIdentity | null
  ): Survey[] {
    if (!user) return [];

    const eligible: Survey[] = [];

    for (const survey of this.surveys.values()) {
      if (!survey.enabled) continue;

      // 1. Triggers
      const matchesTrigger = survey.triggers.some(t => {
        if (t.type !== triggerType) return false;
        if (t.type === 'url_match' || t.type === 'event') {
          if (!t.pattern) return true;
          return triggerContext.includes(t.pattern);
        }
        return false;
      });
      if (!matchesTrigger) continue;

      // 2. Audience
      if (survey.segmentId) {
        if (!this.segments.evaluate(survey.segmentId, user.traits)) {
          continue;
        }
      }

      // 3. Frequency Caps (already responded?)
      const previousResponses = this.responses.get(user.id)?.get(survey.id) ?? [];
      const cap = survey.caps?.global ?? 1;
      // Zero denies delivery; malformed runtime policy must not become uncapped.
      if (survey.caps?.global === null || !Number.isSafeInteger(cap) || cap < 0 || previousResponses.length >= cap) continue;

      eligible.push(survey);
    }

    return eligible;
  }

  trackResponse(response: SurveyResponse, user: UserIdentity) {
    let surveys = this.responses.get(user.id);
    if (!surveys) { surveys = new Map(); this.responses.set(user.id, surveys); }
    const list = surveys.get(response.surveyId) ?? [];
    list.push(response);
    surveys.set(response.surveyId, list);
  }
}
