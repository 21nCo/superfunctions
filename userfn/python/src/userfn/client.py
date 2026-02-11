from typing import Optional, List, Any
from .types import UserFnOptions, FlagValue, UserTraits, Campaign, Survey
from .core.identity import IdentityManager
from .core.flags import FlagEvaluator
from .core.segments import SegmentEvaluator
from .core.messaging import MessagingEngine

class UserFnClient:
    def __init__(self, options: UserFnOptions):
        self.options = options
        self.identity = IdentityManager()
        self.segments = SegmentEvaluator()
        self.flags = FlagEvaluator([], self.segments)
        self.messaging = MessagingEngine(self.segments)
        # self.surveys = SurveyEngine(self.segments) # TODO: Implement SurveyEngine

        if options.bootstrap_flags:
            # TODO: Convert simple dict to FlagConfig if needed or just support simple flags
            pass

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
