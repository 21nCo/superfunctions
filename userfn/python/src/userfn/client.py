from .core.messaging_http import HttpMessaging, MessagingDeliveryError
from .core.exposures import FlagExposures
from .core.consent import ConsentPolicy
from .core.config_refresh import ConfigRefreshLoop
from .core.config_http import HttpConfigService, ConfigRefreshError
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
        self._messaging_epoch = 0
        self.durable_messaging = HttpMessaging(options) if options.messaging_state_path else None
        self.consent = ConsentPolicy(options.consent, options.do_not_track)
        self.exposures = FlagExposures(options.exposures, options.environment) if options.exposures else None
        self._config_environment = options.environment
        self._config_refresh_loop = None
        self.config_service = HttpConfigService(options) if options.config else None
        self.identity = IdentityManager()
        self.feedback = FeedbackEngine(options.feedback_service if options.feedback_service is not None else (HttpFeedbackService(options) if options.endpoint else None), self.identity.get_user)
        self.segments = SegmentEvaluator()
        self.flags = FlagEvaluator([], self.segments, options.environment)
        self.messaging = MessagingEngine(self.segments)
        # self.surveys = SurveyEngine(self.segments) # TODO: Implement SurveyEngine

        self._bootstrap_keys = set((options.bootstrap_flags or {}).keys())
        self.flags.set_flags([
            FlagConfig(key=key, default_value=value, variations=[], rules=[], enabled=True)
            for key, value in (options.bootstrap_flags or {}).items()
        ])

    def identify(self, id: str, traits: Optional[UserTraits] = None):
        self._messaging_epoch += 1
        self.identity.identify(id, traits)

    def reset(self):
        self._messaging_epoch += 1
        self.identity.reset()

    def get_flag(self, key: str, default_value: FlagValue = False) -> FlagValue:
        user = self.identity.get_user()
        result = self.flags.evaluate(key, default_value, user)
        if key in self._bootstrap_keys and result["reason"] == "default_value":
            result["reason"] = "bootstrap"
        if self.exposures and self.consent.state()['analytics']:
            self.exposures.capture(key, result, user)
        return result["value"]

    def set_consent(self, *, analytics=None, messaging=None, do_not_track=None):
        self._messaging_epoch += 1
        previous = self.consent.state()
        self.consent.update(analytics=analytics, messaging=messaging, do_not_track=do_not_track)
        if not self.consent.state()['analytics'] and self.exposures and (previous['analytics'] or self.exposures.queue):
            self.exposures.discard_pending()

    def get_consent(self):
        return self.consent.state()

    async def flush_exposures(self):
        if self.exposures:
            await self.exposures.flush()

    async def close_exposures(self):
        if self.exposures:
            await self.exposures.close()

    def get_exposure_status(self):
        return self.exposures.status() if self.exposures else {"pending": 0, "dropped": 0, "discarded": 0, "closed": False}

    # Messaging
    def trigger(self, trigger_type: str, context: str) -> List[Campaign]:
        """
        Check for eligible campaigns. 
        Returns list of eligible campaigns (unlike TS which usually renders them).
        """
        if not self.consent.state()['messaging']:
            return []
        user = self.identity.get_user()
        campaigns = self.messaging.get_eligible_messages(trigger_type, context, user, bool(self.durable_messaging))
        if not campaigns: return []
        if not self.durable_messaging:
            if any(c.caps and any(value is not None for value in vars(c.caps).values()) for c in campaigns):
                raise MessagingDeliveryError('Capped campaigns require durable messaging configuration')
            return campaigns
        epoch = self._messaging_epoch
        with self.durable_messaging.exclusive():
            if not self.consent.state()['messaging']: return []
            allowed = lambda: self.consent.state()['messaging'] and self._messaging_epoch == epoch and self.identity.get_user() == user
            for campaign in campaigns:
                if not allowed(): return []
                outcome = self.durable_messaging.admit(campaign.id, user.id, allowed)
                if outcome == 'admitted': return [campaign]
                if outcome != 'denied': return []
            return []

    def confirm_message_shown(self, campaign_id):
        if not self.durable_messaging: raise MessagingDeliveryError('Durable messaging is not configured')
        if not self.consent.state()['messaging']: return
        self.durable_messaging.confirm(campaign_id)

    def get_message_delivery_status(self):
        return self.durable_messaging.status() if self.durable_messaging else {}

    # Configuration setters (normally loaded from server)
    async def refresh_config(self) -> bool:
        if not self.config_service:
            raise ConfigRefreshError('Signed configuration is not configured')
        def apply(flags, segments):
            evaluator = FlagEvaluator(flags, self.segments, self._config_environment)
            self.segments.set_segments(segments)
            self.flags = evaluator
            self._bootstrap_keys.clear()
        return await self.config_service.refresh(apply)

    def close_config(self):
        """Permanently close config transport; in-flight work cannot apply later."""
        if self._config_refresh_loop:
            self._config_refresh_loop.state['running'] = False
            self._config_refresh_loop.state.pop('next_refresh_at', None)
            if self._config_refresh_loop.task:
                self._config_refresh_loop.task.cancel()
        if self.config_service:
            self.config_service.close()

    def start_config_refresh(self):
        if not self.config_service or self.config_service.closed:
            raise ConfigRefreshError('Signed configuration is unavailable or closed')
        if self._config_refresh_loop is None:
            interval = self.options.refresh_interval if self.options.refresh_interval is not None else 30000
            self._config_refresh_loop = ConfigRefreshLoop(self.refresh_config, self.config_service.cancel, interval)
        self._config_refresh_loop.start()

    async def stop_config_refresh(self):
        if self.config_service:
            self.config_service.cancel_pending()
        if self._config_refresh_loop:
            await self._config_refresh_loop.stop()
        elif self.config_service:
            await self.config_service.cancel()

    def get_config_refresh_status(self):
        return self._config_refresh_loop.status() if self._config_refresh_loop else {'running': False, 'consecutive_failures': 0}

    def set_flags(self, flags):
        self.flags.set_flags(flags)
        self._bootstrap_keys.clear()
        if self.config_service:
            self.config_service.invalidate()

    def set_segments(self, segments):
        self.segments.set_segments(segments)
        if self.config_service:
            self.config_service.invalidate()

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
