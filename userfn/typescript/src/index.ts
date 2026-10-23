import { IdentityManager } from './core/identity';
import { FlagEvaluator } from './core/flags';
import { SegmentEvaluator } from './core/segments';
import { MessagingEngine } from './core/messaging';
import { SurveyEngine } from './core/surveys';
import { FeedbackEngine } from './core/feedback';
import { VanillaRenderer } from './ui/renderer';
import { UserFnOptions, FlagValue, UserTraits, EventProperties, FeedbackSubmission, Campaign, Survey } from './types';

export class UserFnClient {
  private identity: IdentityManager;
  private flags: FlagEvaluator;
  private segments: SegmentEvaluator;
  private messaging: MessagingEngine;
  private surveys: SurveyEngine;
  private feedback: FeedbackEngine;
  private renderer: VanillaRenderer | null = null;
  private options: UserFnOptions;

  constructor(options: UserFnOptions) {
    this.options = options;
    this.identity = new IdentityManager();
    this.segments = new SegmentEvaluator(); 
    this.flags = new FlagEvaluator([], this.segments);
    this.messaging = new MessagingEngine(this.segments);
    this.surveys = new SurveyEngine(this.segments);
    this.feedback = new FeedbackEngine();
    
    if (typeof window !== 'undefined') {
      this.renderer = new VanillaRenderer();
    }

    // In the future, fetch bootstrap flags here or hydrate from options
    if (options.bootstrapFlags) {
      // transform simple record to FlagConfig if needed
    }
  }

  // ... trigger ...

  openFeedbackWidget() {
    this.renderer?.renderFeedbackWidget(async (submission) => {
      await this.feedback.submit(submission);
    });
  }

  // Direct submit
  async submitFeedback(feedback: FeedbackSubmission): Promise<void> {
    return this.feedback.submit(feedback);
  }

  // ... rest of class


  // Trigger check for messaging and surveys
  trigger(type: 'url_match' | 'event', context: string) {
    const user = this.identity.getUser();
    
    // 1. Messaging
    const campaigns = this.messaging.getEligibleMessages(type, context, user);
    if (campaigns.length > 0) {
      const topCampaign = campaigns[0];
      this.renderer?.render(
        topCampaign,
        () => this.messaging.trackDelivery(topCampaign.id, 'dismissed'),
        () => {
          this.messaging.trackDelivery(topCampaign.id, 'clicked');
          if (topCampaign.content.ctaUrl) {
            window.location.href = topCampaign.content.ctaUrl;
          }
        }
      );
      this.messaging.trackDelivery(topCampaign.id, 'shown');
      return; // Prioritize messaging over surveys? Or show both? prioritizing for now.
    }

    // 2. Surveys
    const surveys = this.surveys.getEligibleSurveys(type, context, user);
    if (surveys.length > 0) {
      const survey = surveys[0];
      this.renderer?.renderSurvey(
        survey,
        (response) => {
          this.surveys.trackResponse(response);
          // TODO: emit to watchfn
        },
        () => {
           // dismissed survey
        }
      );
    }
  }

  // Test method to inject campaigns for verification
  setCampaigns(campaigns: Campaign[]) {
    this.messaging.setCampaigns(campaigns);
  }

  setSurveys(surveys: Survey[]) {
    this.surveys.setSurveys(surveys);
  }


  identify(id: string, traits: UserTraits = {}) {
    this.identity.identify(id, traits);
    // TODO: Send identify event to server
  }

  reset() {
    this.identity.reset();
  }

  getFlag(key: string, defaultValue: FlagValue = false): FlagValue {
    const user = this.identity.getUser();
    return this.flags.getFlag(key, defaultValue, user);
  }

  track(event: string, properties?: EventProperties) {
    console.log(`[UserFn] Track: ${event}`, properties);
    // TODO: Send to watchfn
  }

  render(slotId: string): void {
    console.log(`[UserFn] Render slot: ${slotId}`);
    // TODO: Return/render content for slot
  }
}

export * from './types';
export * from './operator';
