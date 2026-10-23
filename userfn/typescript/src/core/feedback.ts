import { FeedbackSubmission, FeedbackItem } from '../types';

export class FeedbackEngine {
  constructor() {}

  async submit(feedback: FeedbackSubmission): Promise<void> {
    // TODO: Send to userfn service
    console.log('[UserFn] Submitting feedback:', feedback);
    // In a real implementation, this would be a fetch() call
    return Promise.resolve();
  }

  // Placeholder for fetching board items
  async getFeedbackBoard(): Promise<FeedbackItem[]> {
    return Promise.resolve([]);
  }
}
