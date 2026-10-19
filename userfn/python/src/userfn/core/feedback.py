from typing import Callable, Optional
from ..types import FeedbackSubmission, FeedbackContext, FeedbackReceipt, FeedbackService, UserIdentity


class FeedbackDeliveryError(RuntimeError):
    pass


class FeedbackEngine:
    def __init__(self, service: Optional[FeedbackService] = None,
                 get_user: Callable[[], Optional[UserIdentity]] = lambda: None):
        self.service = service
        self.get_user = get_user

    async def submit(self, feedback: FeedbackSubmission) -> None:
        if (not isinstance(feedback, FeedbackSubmission)
                or not isinstance(feedback.title, str) or not feedback.title.strip()
                or not isinstance(feedback.body, str) or not feedback.body.strip()
                or feedback.category not in ('bug', 'feature', 'general')):
            raise ValueError('Feedback requires a title, body, and valid category')
        if self.service is None:
            raise FeedbackDeliveryError('Feedback service is not configured')
        receipt = await self.service.submit(feedback, FeedbackContext(source='in_app', user=self.get_user()))
        if (not isinstance(receipt, FeedbackReceipt) or receipt.accepted is not True
                or not isinstance(receipt.id, str) or not receipt.id.strip()):
            raise FeedbackDeliveryError('Feedback service did not acknowledge acceptance')
