import { ConsentPolicy } from './core/consent';
import type { ConsentPatch, ConsentState } from './types';
import { resolveCampaignUrl } from './ui/campaign-url';
import { FlagExposures } from './core/exposures';
import { ConfigRefreshLoop } from './core/config-refresh';
import { HttpConfigService, ConfigRefreshError } from './core/config-http';
export { ConfigRefreshError } from './core/config-http';
import { IdentityManager } from './core/identity';
import { FlagEvaluator } from './core/flags';
import { createFlagObservation, type FlagObservation } from './core/flag-observation';
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
  private exposures?: FlagExposures;
  private bootstrapKeys = new Set<string>();
  private configRefreshLoop?: ConfigRefreshLoop;
  private readonly configEnvironment?: string;
  private readonly consent: ConsentPolicy;
  private consentEpoch = 0;
  private lastConsent?: ConsentState;
  private flagRevision = 0;
  private readonly flagListeners = new Set<() => void>();

  constructor(options: UserFnOptions) {
    this.options = options;
    this.consent = new ConsentPolicy(options.consent);
    this.consent.update({ doNotTrack: options.doNotTrack });
    this.lastConsent = this.consent.state();
    this.exposures = options.exposures ? new FlagExposures(options.exposures, options.environment, () => this.syncConsent().analytics) : undefined;
    this.configEnvironment = options.environment;
    this.configService = options.config ? new HttpConfigService(options) : undefined;
    this.identity = new IdentityManager();
    this.segments = new SegmentEvaluator(); 
    this.flags = new FlagEvaluator([], this.segments, options.environment);
    this.messaging = new MessagingEngine(this.segments);
    this.surveys = new SurveyEngine(this.segments);
    this.feedback = new FeedbackEngine(options.feedbackService ?? (options.endpoint ? new HttpFeedbackService(options) : undefined), () => this.identity.getUser());
    
    if (typeof window !== 'undefined') {
      this.renderer = new VanillaRenderer(() => this.syncConsent().messaging);
    }

    this.bootstrapKeys = new Set(Object.keys(options.bootstrapFlags ?? {}));
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
    if (!this.syncConsent().messaging) return;
    const user = this.identity.getUser();
    
    // 1. Messaging
    const campaigns = this.messaging.getEligibleMessages(type, context, user);
    if (campaigns.length > 0) {
      const topCampaign = campaigns[0];
      this.renderer?.render(
        topCampaign,
        () => { if (this.syncConsent().messaging) this.messaging.trackDelivery(topCampaign.id, 'dismissed'); },
        () => {
          if (!this.syncConsent().messaging) return;
          this.messaging.trackDelivery(topCampaign.id, 'clicked');
          const destination = resolveCampaignUrl(topCampaign.content.ctaUrl, window.location.href);
          if (destination) window.location.href = destination;
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
          if (!this.syncConsent().messaging) return;
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
      this.bootstrapKeys.clear();
      this.publishFlags();
    });
  }

  /** Permanently closes this client's config transport and prevents any late application. */
  closeConfig(): Promise<void> {
    this.configService?.close();
    return this.configRefreshLoop?.stop() ?? this.configService?.cancel() ?? Promise.resolve();
  }

  startConfigRefresh(): void {
    if (!this.configService || this.configService.isClosed) throw new ConfigRefreshError('Signed configuration is unavailable or closed');
    this.configRefreshLoop ??= new ConfigRefreshLoop(() => this.refreshConfig(), () => this.configService!.cancel(), this.options.refreshInterval ?? 30000);
    this.configRefreshLoop.start();
  }

  stopConfigRefresh(): Promise<void> {
    return this.configRefreshLoop?.stop() ?? this.configService?.cancel() ?? Promise.resolve();
  }

  getConfigRefreshStatus() {
    return this.configRefreshLoop?.status() ?? { running: false, consecutiveFailures: 0 };
  }

  setFlags(flags: FlagConfig[]) {
    this.flags.setFlags(flags);
    this.bootstrapKeys.clear();
    this.configService?.invalidate();
    this.publishFlags();
  }

  setSegments(segments: Segment[]) {
    this.segments.setSegments(segments);
    this.configService?.invalidate();
    this.publishFlags();
  }


  identify(id: string, traits: UserTraits = {}) {
    this.identity.identify(id, traits);
    this.publishFlags();
    // TODO: Send identify event to server
  }

  reset() {
    this.identity.reset();
    this.publishFlags();
  }

  getFlag(key: string, defaultValue: FlagValue = false): FlagValue {
    const user = this.identity.getUser();
    const result = this.flags.evaluate(key, defaultValue, user);
    if (this.bootstrapKeys.has(key) && result.reason === 'default_value') result.reason = 'bootstrap';
    if (this.syncConsent().analytics) this.exposures?.capture(key, result, user);
    return result.value;
  }

  /** Observe without exposure side effects. Track only the snapshot committed by a consumer. */
  observeFlag(key: string, defaultValue: FlagValue = false): FlagObservation {
    return createFlagObservation(key, defaultValue, {
      revision: () => this.flagRevision,
      subscribe: listener => {
        const registered = () => listener();
        this.flagListeners.add(registered);
        return () => { this.flagListeners.delete(registered); };
      },
      evaluate: fallback => {
        const user = this.identity.getUser();
        const result = this.flags.evaluate(key, fallback, user);
        if (this.bootstrapKeys.has(key) && result.reason === 'default_value') result.reason = 'bootstrap';
        // Exposure needs identity only, never a mutable trait reference.
        const allowed = this.syncConsent().analytics;
        return { result, user: user ? { id: user.id, traits: {} } : null, token: allowed ? this.consentEpoch : null };
      },
      capture: (result, user, token) => {
        if (this.syncConsent().analytics && token === this.consentEpoch) this.exposures?.capture(key, result, user);
      },
    });
  }

  private publishFlags(): void {
    this.flagRevision++;
    for (const listener of [...this.flagListeners]) {
      if (!this.flagListeners.has(listener)) continue;
      // One subscriber cannot prevent other consumers observing a committed configuration.
      try { listener(); } catch { console.error('UserFn flag subscriber failed'); }
    }
  }

  setConsent(patch: ConsentPatch): void { this.consent.update(patch); this.syncConsent(); }
  getConsent(): ConsentState { return this.syncConsent(); }
  private syncConsent(): ConsentState {
    const state = this.consent.state();
    const previous = this.lastConsent;
    if (this.lastConsent?.analytics !== state.analytics) this.consentEpoch++;
    this.lastConsent = state;
    if (!state.analytics && (previous?.analytics !== false || (this.exposures?.status().pending ?? 0) > 0)) this.exposures?.discardPending();
    if (!state.messaging) this.renderer?.dismissMessages();
    return state;
  }

  flushExposures(): Promise<void> { this.syncConsent(); return this.exposures?.flush() ?? Promise.resolve(); }
  closeExposures(): Promise<void> { this.syncConsent(); return this.exposures?.close() ?? Promise.resolve(); }
  getExposureStatus() { this.syncConsent(); return this.exposures?.status() ?? { pending: 0, dropped: 0, discarded: 0, closed: false }; }

  track(event: string, properties?: EventProperties) {
    if (!this.syncConsent().analytics) return;
    console.log(`[UserFn] Track: ${event}`, properties);
    // TODO: Send to watchfn
  }

  render(slotId: string): void {
    if (!this.syncConsent().messaging) return;
    console.log(`[UserFn] Render slot: ${slotId}`);
    // TODO: Return/render content for slot
  }
}

export * from './types';
export * from './operator';

export { FeedbackDeliveryError } from './core/feedback';

export { FeedbackHTTPError } from './core/feedback-http';

export type { FlagObservation, FlagSnapshot } from './core/flag-observation';
