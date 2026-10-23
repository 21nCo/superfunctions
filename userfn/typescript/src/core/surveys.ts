import { Survey, CampaignTrigger, UserIdentity, SurveyResponse } from '../types';
import { SegmentEvaluator } from './segments';

export class SurveyEngine {
  private surveys: Map<string, Survey> = new Map();
  private responses: Map<string, SurveyResponse[]> = new Map(); // surveyId -> responses
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
      const previousResponses = this.responses.get(survey.id) || [];
      if (survey.caps?.global && previousResponses.length >= survey.caps.global) {
        continue;
      }
      
      // Default: don't show if already responded once, unless cap > 1
      if (!survey.caps?.global && previousResponses.length > 0) {
        continue; 
      }

      eligible.push(survey);
    }

    return eligible;
  }

  trackResponse(response: SurveyResponse) {
    const list = this.responses.get(response.surveyId) || [];
    list.push(response);
    this.responses.set(response.surveyId, list);
  }
}
