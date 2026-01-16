import { IdentityManager } from './core/identity';
import { FlagEvaluator } from './core/flags';
import { UserFnOptions, FlagValue, UserTraits, EventProperties, FeedbackSubmission } from './types';

export class UserFnClient {
  private identity: IdentityManager;
  private flags: FlagEvaluator;
  private options: UserFnOptions;

  constructor(options: UserFnOptions) {
    this.options = options;
    this.identity = new IdentityManager();
    this.flags = new FlagEvaluator();
    
    // In the future, fetch bootstrap flags here or hydrate from options
    if (options.bootstrapFlags) {
      // transform simple record to FlagConfig if needed, or just store for simple lookup
      // For now, we assume simple lookup is not fully implemented in evaluator
    }
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
