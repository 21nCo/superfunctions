from typing import List, Dict, Optional
import time
from dataclasses import dataclass
from ..types import Campaign, CampaignTrigger, UserIdentity, MessageKind
from .segments import SegmentEvaluator

@dataclass
class MessageDelivery:
    campaign_id: str
    status: str # 'shown', 'dismissed', 'clicked'
    timestamp: int

class MessagingEngine:
    def __init__(self, segment_evaluator: SegmentEvaluator):
        self.campaigns: Dict[str, Campaign] = {}
        # Simple in-memory delivery tracking for session/global caps within this instance
        self.deliveries: Dict[str, List[MessageDelivery]] = {}
        self.segments = segment_evaluator

    def set_campaigns(self, campaigns: List[Campaign]):
        self.campaigns = {c.id: c for c in campaigns}

    def get_eligible_messages(
        self,
        trigger_type: str, # 'url_match' | 'event'
        trigger_context: str, # URL or Event Name
        user: Optional[UserIdentity] = None, authoritative: bool = False
    ) -> List[Campaign]:
        if not user:
            return []

        eligible: List[Campaign] = []

        for campaign in self.campaigns.values():
            if not campaign.enabled:
                continue

            # 1. Check Triggers
            matches_trigger = False
            for t in campaign.triggers:
                if t.type != trigger_type:
                    continue
                
                if t.type in ('url_match', 'event'):
                    if not t.pattern:
                        matches_trigger = True
                        break
                    # Simple inclusion check (could upgrade to regex/glob later)
                    if t.pattern in trigger_context:
                        matches_trigger = True
                        break
            
            if not matches_trigger:
                continue

            # 2. Check Audience (Segments)
            if campaign.segment_id:
                if not self.segments.evaluate(campaign.segment_id, user.traits):
                    continue

            # 3. Check Frequency Caps (Simple global cap)
            if not authoritative and campaign.caps and campaign.caps.global_cap is not None:
                deliveries = self.deliveries.get(campaign.id, [])
                shown_count = sum(1 for d in deliveries if d.status == 'shown')
                if shown_count >= campaign.caps.global_cap:
                    continue
            
            eligible.append(campaign)

        # Sort by priority (descending)
        # Handle None priority by treating as 0
        eligible.sort(key=lambda c: c.priority or 0, reverse=True)
        return eligible

    def track_delivery(self, campaign_id: str, status: str):
        if campaign_id not in self.deliveries:
            self.deliveries[campaign_id] = []
        
        self.deliveries[campaign_id].append(MessageDelivery(
            campaign_id=campaign_id,
            status=status,
            timestamp=int(time.time() * 1000)
        ))
