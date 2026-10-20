from typing import Optional, List, Any
from .types import UserFnOptions, FlagValue, FlagConfig, UserTraits, Campaign, Survey, FeedbackSubmission
from .core.identity import IdentityManager
from .core.feedback import FeedbackEngine
from .core.feedback_http import HttpFeedbackService
from .core.flags import FlagEvaluator
from .core.segments import SegmentEvaluator
from .core.messaging import MessagingEngine

class UserFnClient:
    def __init__(self, options: UserFnOptions):
        self.options = options
        self.identity = IdentityManager()
        self.feedback = FeedbackEngine(options.feedback_service if options.feedback_service is not None else (HttpFeedbackService(options) if options.endpoint else None), self.identity.get_user)
        self.segments = SegmentEvaluator()
        self.flags = FlagEvaluator([], self.segments)
        self.messaging = MessagingEngine(self.segments)
        # self.surveys = SurveyEngine(self.segments) # TODO: Implement SurveyEngine

        self.flags.set_flags([
            FlagConfig(key=key, default_value=value, variations=[], rules=[], enabled=True)
            for key, value in (options.bootstrap_flags or {}).items()
        ])

    def identify(self, id: str, traits: Optional[UserTraits] = None):
        self.identity.identify(id, traits)

    def reset(self):
        self.identity.reset()

    def get_flag(self, key: str, default_value: FlagValue = False) -> FlagValue:
        user = self.identity.get_user()
        return self.flags.get_flag(key, default_value, user)

    # Messaging
    def trigger(self, trigger_type: str, context: str) -> List[Campaign]:
        """
        Check for eligible campaigns. 
        Returns list of eligible campaigns (unlike TS which usually renders them).
        """
        user = self.identity.get_user()
        return self.messaging.get_eligible_messages(trigger_type, context, user)

    # Configuration setters (normally loaded from server)
    def set_flags(self, flags):
        self.flags.set_flags(flags)

    def set_segments(self, segments):
        self.segments.set_segments(segments)

    def set_campaigns(self, campaigns):
        self.messaging.set_campaigns(campaigns)

    async def submit_feedback(self, feedback: FeedbackSubmission, *, idempotency_key: Optional[str] = None) -> None:
        await self.feedback.submit(feedback, idempotency_key)

    async def get_feedback_board(self, *, limit=20, after=None, status=None, tag=None, product_area=None):
        options = {'limit': limit}
        if after is not None:
            options['after'] = after
        if status is not None:
            options['status'] = status
        if tag is not None:
            options['tag'] = tag
        if product_area is not None:
            options['productArea'] = product_area
        return await self.feedback.get_feedback_board(**options)

    async def vote_feedback(self, feedback_id: str, direction: int):
        return await self.feedback.vote_feedback(feedback_id, direction)

    async def set_feedback_metadata(self, feedback_id: str, patch: dict):
        """Replace tags and/or assign productArea (None clears it); omitted fields remain unchanged."""
        return await self.feedback.set_feedback_metadata(feedback_id, patch)

    async def set_feedback_status(self, feedback_id: str, status: str):
        return await self.feedback.set_feedback_status(feedback_id, status)
