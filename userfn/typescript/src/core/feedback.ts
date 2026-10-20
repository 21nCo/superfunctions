import type { FeedbackSubmission, FeedbackItem, FeedbackService, FeedbackSubmitOptions, UserIdentity } from '../types';

export class FeedbackDeliveryError extends Error {
  constructor(message: string) { super(message); this.name = 'FeedbackDeliveryError'; }
}

export class FeedbackEngine {
  constructor(private service?: FeedbackService, private getUser: () => UserIdentity | null = () => null) {}

  async submit(feedback: FeedbackSubmission, options: FeedbackSubmitOptions = {}): Promise<void> {
    if (!feedback || typeof feedback.title !== 'string' || !feedback.title.trim() ||
        typeof feedback.body !== 'string' || !feedback.body.trim() ||
        !['bug', 'feature', 'general'].includes(feedback.category)) {
      throw new TypeError('Feedback requires a title, body, and valid category');
    }
    if (options.idempotencyKey !== undefined && !/^[A-Za-z0-9._:-]{1,128}$/.test(options.idempotencyKey)) throw new TypeError('Invalid idempotency key');
    if (!this.service) throw new FeedbackDeliveryError('Feedback service is not configured');
    const receipt = await this.service.submit(feedback, { source: 'in_app', user: this.getUser(), ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }) });
    if (!receipt || receipt.accepted !== true || typeof receipt.id !== 'string' || !receipt.id.trim()) {
      throw new FeedbackDeliveryError('Feedback service did not acknowledge acceptance');
    }
  }

  async getFeedbackBoard(): Promise<FeedbackItem[]> {
    throw new FeedbackDeliveryError('Feedback board service is not implemented');
  }
}
