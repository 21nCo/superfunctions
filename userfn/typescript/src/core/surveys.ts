import { Survey, CampaignTrigger, UserIdentity, SurveyResponse } from '../types';
import { SegmentEvaluator } from './segments';
import { surveyScheduleActive } from './survey-questions';

export class SurveyEngine {
  private surveys: Map<string, Survey> = new Map();
  private responses = new Map<string, Map<string, number>>(); // userId -> surveyId -> accepted count
  private segments: SegmentEvaluator;

  constructor(segments: SegmentEvaluator, private readonly now: () => number = () => Date.now()) {
    this.segments = segments;
  }

  setSurveys(surveys: Survey[]) {
    surveys.forEach(survey => surveyScheduleActive(survey.schedule, 0));
    this.surveys.clear();
    surveys.forEach(s => this.surveys.set(s.id, s));
  }

  getEligibleSurveys(
    triggerType: CampaignTrigger['type'],
    triggerContext: string,
    user: UserIdentity | null,
    recovering: ReadonlySet<string> = new Set(),
  ): Survey[] {
    if (!user) return [];

    const eligible: Survey[] = [];

    for (const survey of this.surveys.values()) {
      // Recovery can only resend a previously frozen journal entry; service policy
      // still decides whether it is a replay or an inadmissible new response.
      if (recovering.has(survey.id)) { eligible.unshift(survey); continue; }
      if (!survey.enabled || !surveyScheduleActive(survey.schedule, this.now())) continue;

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
      const previousResponses = this.responses.get(user.id)?.get(survey.id) ?? 0;
      const cap = survey.caps?.global ?? 1;
      // Zero denies delivery; malformed runtime policy must not become uncapped.
      if (survey.caps?.global === null || !Number.isSafeInteger(cap) || cap < 0 || previousResponses >= cap) continue;

      eligible.push(survey);
    }

    return eligible;
  }

  trackResponse(response: SurveyResponse, user: UserIdentity) {
    this.setResponseCount(user.id, response.surveyId, (this.responses.get(user.id)?.get(response.surveyId) ?? 0) + 1);
  }

  setResponseCount(userId: string, surveyId: string, count: number) {
    if (!Number.isSafeInteger(count) || count < 0) throw new TypeError('Invalid survey response count');
    let surveys = this.responses.get(userId);
    if (!surveys) { surveys = new Map(); this.responses.set(userId, surveys); }
    surveys.set(surveyId, count);
  }
}
