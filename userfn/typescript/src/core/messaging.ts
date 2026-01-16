import { Campaign, CampaignTrigger, UserIdentity, MessageDelivery } from '../types';
import { SegmentEvaluator } from './segments';

export class MessagingEngine {
  private campaigns: Map<string, Campaign> = new Map();
  private deliveries: Map<string, MessageDelivery[]> = new Map(); // campaignId -> deliveries
  private segments: SegmentEvaluator;

  constructor(segments: SegmentEvaluator) {
    this.segments = segments;
  }

  setCampaigns(campaigns: Campaign[]) {
    this.campaigns.clear();
    campaigns.forEach(c => this.campaigns.set(c.id, c));
  }

  // Called on URL change or event
  getEligibleMessages(
    triggerType: CampaignTrigger['type'],
    triggerContext: string, // URL or Event Name
    user: UserIdentity | null
  ): Campaign[] {
    if (!user) return []; // Messaging usually requires identity

    const eligible: Campaign[] = [];

    for (const campaign of this.campaigns.values()) {
      if (!campaign.enabled) continue;

      // 1. Check Triggers
      const matchesTrigger = campaign.triggers.some(t => {
        if (t.type !== triggerType) return false;
        if (t.type === 'url_match' || t.type === 'event') {
          // Simple string match or regex if pattern provided
          // Assuming simple glob/substring for now if it's URL
          if (!t.pattern) return true;
          // Simple "includes" or "exact" for now. 
          // For URL, usually glob. 
          return triggerContext.includes(t.pattern);
        }
        return false;
      });

      if (!matchesTrigger) continue;

      // 2. Check Audience (Segments)
      if (campaign.segmentId) {
        if (!this.segments.evaluate(campaign.segmentId, user.traits)) {
          continue;
        }
      }

      // 3. Check Frequency Caps (Simple global cap for now)
      const campaignDeliveries = this.deliveries.get(campaign.id) || [];
      const shownCount = campaignDeliveries.filter(d => d.status === 'shown').length;
      if (campaign.caps?.global && shownCount >= campaign.caps.global) {
        continue;
      }

      eligible.push(campaign);
    }

    // Sort by priority (descending)
    return eligible.sort((a, b) => (b.priority || 0) - (a.priority || 0));
  }

  trackDelivery(campaignId: string, status: MessageDelivery['status']) {
    const list = this.deliveries.get(campaignId) || [];
    list.push({ campaignId, status, timestamp: Date.now() });
    this.deliveries.set(campaignId, list);
  }
}
