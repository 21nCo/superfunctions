import type { FeedbackSubmission, FeedbackBoardOptions, FeedbackBoardPage, FeedbackStatus, FeedbackMetadataPatch, FeedbackMetadataResult, FeedbackService, FeedbackSubmitOptions, UserIdentity } from '../types';

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

  async getFeedbackBoard(options?: FeedbackBoardOptions): Promise<FeedbackBoardPage> {
    if (!this.service?.list) throw new FeedbackDeliveryError('Feedback board service is not configured');
    return this.service.list(options);
  }
  async voteFeedback(id: string, direction: -1 | 0 | 1) {
    if (!this.service?.vote) throw new FeedbackDeliveryError('Feedback voting service is not configured');
    return this.service.vote(id, direction);
  }
  async setFeedbackMetadata(id: string, patch: FeedbackMetadataPatch): Promise<FeedbackMetadataResult> {
    if (!this.service?.setMetadata) throw new FeedbackDeliveryError('Feedback metadata service is not configured');
    return this.service.setMetadata(id, patch);
  }
  async setFeedbackStatus(id: string, status: FeedbackStatus) {
    if (!this.service?.setStatus) throw new FeedbackDeliveryError('Feedback moderation service is not configured');
    return this.service.setStatus(id, status);
  }
}
