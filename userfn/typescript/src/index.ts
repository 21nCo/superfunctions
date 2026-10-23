import { v4 as uuidv4 } from 'uuid';
import { canonicalJson } from './utils/json';
import { HttpSurveyService, SurveyDeliveryError } from './core/surveys-http';
export { SurveyDeliveryError } from './core/surveys-http';
import { HttpMessaging, MessagingDeliveryError } from './core/messaging-http';
export { MessagingDeliveryError } from './core/messaging-http';
export type { DurableMessagingOptions, MessageStorage } from './core/messaging-http';
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
import { UserFnOptions, FlagValue, FlagConfig, Segment, UserTraits, EventProperties, FeedbackSubmission, FeedbackSubmitOptions, FeedbackBoardOptions, FeedbackStatus, FeedbackMetadataPatch, Campaign, Survey, SurveyResponse, SurveyReceipt } from './types';

export class UserFnClient {
  private identity: IdentityManager;
  private flags: FlagEvaluator;
  private segments: SegmentEvaluator;
  private messaging: MessagingEngine;
  private durableMessaging?: HttpMessaging;
  private surveys: SurveyEngine;
  private surveyService?: HttpSurveyService;
  private renderedSurveyService?: HttpSurveyService;
  private surveyPresentation?: symbol;
  private readonly surveyAttempts = new Map<string, { key: string; response: SurveyResponse; pending?: Promise<SurveyReceipt>; receipt?: SurveyReceipt }>();
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
  private messagingEpoch = 0;
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
    this.durableMessaging = options.messaging ? new HttpMessaging(options) : undefined;
    this.surveys = new SurveyEngine(this.segments);
    if (options.endpoint) {
      this.surveyService = new HttpSurveyService(options);
      // UI retries require a fresh explicit click and a current identity/consent fence.
      this.renderedSurveyService = new HttpSurveyService({ ...options, surveyMaxAttempts: 1 });
    }
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
    const user = this.identity.getUser();
    const key = uuidv4();
    this.renderer?.renderFeedbackWidget(async (submission) => {
      if (this.identity.getUser() !== user) throw new Error('Feedback identity changed');
      await this.feedback.submit(submission, { idempotencyKey: key });
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
  async trigger(type: 'url_match' | 'event', context: string): Promise<void> {
    if (this.durableMessaging) return this.durableMessaging.exclusive(() => this.triggerMessages(type, context));
    return this.triggerMessages(type, context);
  }

  getMessageDeliveryStatus() { return this.durableMessaging?.status() ?? {}; }

  private async triggerMessages(type: 'url_match' | 'event', context: string): Promise<void> {
    if (!this.syncConsent().messaging) return;
    const epoch = this.messagingEpoch;
    const user = this.identity.getUser();
    
    // 1. Messaging
    const campaigns = this.messaging.getEligibleMessages(type, context, user, !!this.durableMessaging);
    for (const topCampaign of campaigns) {
      if (!this.syncConsent().messaging || this.messagingEpoch !== epoch || this.identity.getUser() !== user) return;
      if (!this.durableMessaging && (topCampaign.schedule !== undefined || topCampaign.cooldownMs !== undefined || (topCampaign.caps && Object.values(topCampaign.caps).some(cap => cap !== undefined)))) throw new MessagingDeliveryError('Capped campaigns require durable messaging configuration');
      const render = () => {
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
        const shown = !!this.renderer && ['modal', 'inbox-item'].includes(topCampaign.kind);
        if (shown) this.messaging.trackDelivery(topCampaign.id, 'shown');
        return shown;
      };
      if (this.durableMessaging) {
        const identity = user!.id;
        const outcome = await this.durableMessaging.present(topCampaign.id, identity, () => this.syncConsent().messaging && this.identity.getUser()?.id === identity && epoch === this.messagingEpoch, render, topCampaign.schedule !== undefined || topCampaign.cooldownMs !== undefined);
        if (outcome === 'denied') continue;
      } else render();
      return; // Prioritize messaging over surveys? Or show both? prioritizing for now.
    }

    // Admission can await the network; never fall through to a stale user's survey.
    if (!this.syncConsent().messaging || this.messagingEpoch !== epoch || this.identity.getUser() !== user) return;
    // 2. Surveys
    const surveys = this.surveys.getEligibleSurveys(type, context, user);
    if (surveys.length > 0) {
      const survey = surveys[0];
      const presentation = Symbol('survey');
      this.surveyPresentation = presentation;
      this.renderer?.dismissSurveys?.();
      const owner = JSON.stringify([user!.id, survey.id]);
      let submitted = false;
      const valid = () => !!user && this.syncConsent().messaging && this.messagingEpoch === epoch && this.identity.getUser() === user && this.surveyPresentation === presentation;
      this.renderer?.renderSurvey(
        survey,
        async (response) => {
          if (submitted || !valid() || response.surveyId !== survey.id) return false;
          if (!this.renderedSurveyService) {
            submitted = true;
            this.surveys.trackResponse(response, user!);
            return 'local';
          }
          let attempt = this.surveyAttempts.get(owner);
          if (!attempt) {
            // Never evict an uncertain outcome to admit a fresh response/key.
            if (this.surveyAttempts.size >= 100) throw new SurveyDeliveryError('Pending survey response capacity reached');
            const raw = canonicalJson({ answers: response.answers });
            if (new TextEncoder().encode(raw).byteLength > 65536) throw new SurveyDeliveryError('Survey response exceeds bounds');
            attempt = { key: uuidv4(), response: { surveyId: survey.id, answers: JSON.parse(raw).answers, submittedAt: Date.now() } };
            this.surveyAttempts.set(owner, attempt);
          }
          const saved = attempt;
          if (!saved.receipt) {
            saved.pending ??= this.renderedSurveyService.submit(survey.id, saved.response.answers, saved.key)
              .then(receipt => { saved.receipt = receipt; return receipt; })
              .finally(() => { saved.pending = undefined; });
            await saved.pending;
          }
          // Retain a late receipt for the original owner; do not update stale UI.
          if (submitted || !valid()) return false;
          submitted = true;
          this.surveys.trackResponse({ ...saved.response, submittedAt: saved.receipt!.submittedAt }, user!);
          this.surveyAttempts.delete(owner);
          return 'stored';
        },
        () => { if (this.surveyPresentation === presentation) this.surveyPresentation = undefined; },
        this.surveyAttempts.get(owner)?.response,
      );
    }
  }

  // Test method to inject campaigns for verification
  setCampaigns(campaigns: Campaign[]) {
    this.messaging.setCampaigns(campaigns);
  }

  /** Persist explicit answers. Retain the caller-owned key until acceptance is known. */
  submitSurveyResponse(surveyId: string, answers: import('./types').SurveyResponse['answers'], options: { idempotencyKey: string }) {
    if (!this.surveyService) throw new SurveyDeliveryError('Survey service is not configured');
    return this.surveyService.submit(surveyId, answers, options.idempotencyKey);
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
    this.surveyPresentation = undefined;
    this.renderer?.dismissSurveys?.();
    this.renderer?.dismissFeedback?.();
    this.messagingEpoch++;
    this.identity.identify(id, traits);
    this.publishFlags();
    // TODO: Send identify event to server
  }

  reset() {
    this.surveyPresentation = undefined;
    this.renderer?.dismissSurveys?.();
    this.renderer?.dismissFeedback?.();
    this.messagingEpoch++;
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
    if (this.lastConsent?.messaging !== state.messaging) this.messagingEpoch++;
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
export { validateSurveyBranches, surveyQuestionVisible, surveyScaleBounds, surveyScheduleActive } from './core/survey-questions';
export * from './operator';

export { FeedbackDeliveryError } from './core/feedback';

export { FeedbackHTTPError } from './core/feedback-http';

export type { FlagObservation, FlagSnapshot } from './core/flag-observation';
