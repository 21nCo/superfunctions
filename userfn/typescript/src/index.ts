import { HttpConfigService } from './core/config-http';
export { ConfigRefreshError } from './core/config-http';
import { IdentityManager } from './core/identity';
import { FlagEvaluator } from './core/flags';
import { SegmentEvaluator } from './core/segments';
import { MessagingEngine } from './core/messaging';
import { SurveyEngine } from './core/surveys';
import { FeedbackEngine } from './core/feedback';
import { HttpFeedbackService } from './core/feedback-http';
import { VanillaRenderer } from './ui/renderer';
import { UserFnOptions, FlagValue, FlagConfig, Segment, UserTraits, EventProperties, FeedbackSubmission, FeedbackSubmitOptions, FeedbackBoardOptions, FeedbackStatus, FeedbackMetadataPatch, Campaign, Survey } from './types';

export class UserFnClient {
  private identity: IdentityManager;
  private flags: FlagEvaluator;
  private segments: SegmentEvaluator;
  private messaging: MessagingEngine;
  private surveys: SurveyEngine;
  private feedback: FeedbackEngine;
  private renderer: VanillaRenderer | null = null;
  private options: UserFnOptions;
  private configService?: HttpConfigService;
  private readonly configEnvironment?: string;

  constructor(options: UserFnOptions) {
    this.options = options;
    this.configEnvironment = options.environment;
    this.configService = options.config ? new HttpConfigService(options) : undefined;
    this.identity = new IdentityManager();
    this.segments = new SegmentEvaluator(); 
    this.flags = new FlagEvaluator([], this.segments, options.environment);
    this.messaging = new MessagingEngine(this.segments);
    this.surveys = new SurveyEngine(this.segments);
    this.feedback = new FeedbackEngine(options.feedbackService ?? (options.endpoint ? new HttpFeedbackService(options) : undefined), () => this.identity.getUser());
    
    if (typeof window !== 'undefined') {
      this.renderer = new VanillaRenderer();
    }

    this.flags.setFlags(Object.entries(options.bootstrapFlags ?? {}).map(([key, value]) => ({
      key, defaultValue: value, variations: [], rules: [], enabled: true,
    })));
  }

  // ... trigger ...

  openFeedbackWidget() {
    this.renderer?.renderFeedbackWidget(async (submission) => {
      await this.feedback.submit(submission);
    });
  }

  // Direct submit
  async submitFeedback(feedback: FeedbackSubmission, options?: FeedbackSubmitOptions): Promise<void> {
    return this.feedback.submit(feedback, options);
  }

  getFeedbackBoard(options?: FeedbackBoardOptions) { return this.feedback.getFeedbackBoard(options); }
  voteFeedback(id: string, direction: -1 | 0 | 1) { return this.feedback.voteFeedback(id, direction); }
  setFeedbackMetadata(id: string, patch: FeedbackMetadataPatch) { return this.feedback.setFeedbackMetadata(id, patch); }
  setFeedbackStatus(id: string, status: FeedbackStatus) { return this.feedback.setFeedbackStatus(id, status); }

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

  /** Replace all local flag definitions, including bootstrapped values. */
  /** Returns true when a verified new snapshot was applied, false for verified 304 reuse. */
  async refreshConfig(): Promise<boolean> {
    if (!this.configService) throw new Error('Signed configuration is not configured');
    return this.configService.refresh(value => {
      const flags = new FlagEvaluator(value.flags, this.segments, this.configEnvironment);
      this.segments.setSegments(value.segments);
      this.flags = flags;
    });
  }

  /** Permanently closes this client's config transport and prevents any late application. */
  closeConfig(): void { this.configService?.close(); }

  setFlags(flags: FlagConfig[]) {
    this.flags.setFlags(flags);
    this.configService?.invalidate();
  }

  setSegments(segments: Segment[]) {
    this.segments.setSegments(segments);
    this.configService?.invalidate();
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

export { FeedbackDeliveryError } from './core/feedback';

export { FeedbackHTTPError } from './core/feedback-http';
