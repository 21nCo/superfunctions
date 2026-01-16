import { IdentityManager } from './core/identity';
import { FlagEvaluator } from './core/flags';
import { SegmentEvaluator } from './core/segments';
import { MessagingEngine } from './core/messaging';
import { VanillaRenderer } from './ui/renderer';
import { UserFnOptions, FlagValue, UserTraits, EventProperties, FeedbackSubmission, Campaign } from './types';

export class UserFnClient {
  private identity: IdentityManager;
  private flags: FlagEvaluator;
  private segments: SegmentEvaluator;
  private messaging: MessagingEngine;
  private renderer: VanillaRenderer | null = null;
  private options: UserFnOptions;

  constructor(options: UserFnOptions) {
    this.options = options;
    this.identity = new IdentityManager();
    this.segments = new SegmentEvaluator(); 
    this.flags = new FlagEvaluator([], this.segments);
    this.messaging = new MessagingEngine(this.segments);
    
    if (typeof window !== 'undefined') {
      this.renderer = new VanillaRenderer();
    }

    // In the future, fetch bootstrap flags here or hydrate from options
    if (options.bootstrapFlags) {
      // transform simple record to FlagConfig if needed
    }
  }

  // Trigger check for messaging
  trigger(type: 'url_match' | 'event', context: string) {
    const user = this.identity.getUser();
    const campaigns = this.messaging.getEligibleMessages(type, context, user);

    if (campaigns.length > 0) {
      const topCampaign = campaigns[0];
      // Auto-render top priority message
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
    }
  }

  // Test method to inject campaigns for verification
  setCampaigns(campaigns: Campaign[]) {
    this.messaging.setCampaigns(campaigns);
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

  async submitFeedback(feedback: FeedbackSubmission): Promise<void> {
    console.log(`[UserFn] Submit feedback`, feedback);
    // TODO: Send to API
  }
}

export * from './types';
