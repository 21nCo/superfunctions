from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional, Union, Literal, Protocol

UserTraits = Dict[str, Any]

@dataclass
class UserIdentity:
    id: str
    traits: UserTraits

FlagValue = Union[bool, str, int, float, dict, list]

@dataclass
class FlagVariation:
    id: str
    value: FlagValue
    name: Optional[str] = None

Operator = Literal[
    'equals',
    'does_not_equal',
    'contains',
    'does_not_contain',
    'in',
    'not_in',
    'exists',
    'does_not_exist',
    'gt',
    'gte',
    'lt',
    'lte',
    'regex',
    'startsWith'
]

@dataclass
class SegmentRule:
    id: str
    field: str
    operator: Operator
    value: Any = None

@dataclass
class Segment:
    id: str
    name: str
    rules: List[SegmentRule]
    match_type: Literal['all', 'any'] = 'all'

@dataclass
class FlagRule:
    id: str
    segment_id: Optional[str] = None
    constraints: Optional[List[SegmentRule]] = None
    rollout_percentage: Optional[float] = None # 0-100
    variation_id: Optional[str] = None

@dataclass
class FlagPrerequisite:
    key: str
    expected_value: FlagValue


class _Unset(Enum):
    VALUE = "unset"


@dataclass
class FlagEnvironmentOverride:
    enabled: Optional[bool] = None
    default_value: Union[FlagValue, _Unset] = _Unset.VALUE
    # None explicitly clears the inherited default variation; omission inherits.
    default_variation_id: Union[str, None, _Unset] = _Unset.VALUE
    rules: Optional[List[FlagRule]] = None


@dataclass
class FlagConfig:
    key: str
    variations: List[FlagVariation]
    default_value: FlagValue
    rules: List[FlagRule]
    enabled: bool
    default_variation_id: Optional[str] = None
    prerequisites: List[FlagPrerequisite] = field(default_factory=list)
    environment_overrides: Dict[str, FlagEnvironmentOverride] = field(default_factory=dict)

@dataclass
class SignedConfigOptions:
    tenant_id: str
    trusted_keys: Dict[str, str]
    timeout_ms: int = 10000
    allow_insecure_http: bool = False


@dataclass
class ExposureOptions:
    endpoint: str
    api_key: str
    app: str
    allow_insecure_http: bool = False
    max_queue_size: int = 1000
    timeout_ms: int = 10000


@dataclass
class UserFnOptions:
    api_key: str
    endpoint: Optional[str] = None
    bootstrap_flags: Optional[Dict[str, FlagValue]] = None
    refresh_interval: Optional[int] = None
    feedback_service: Optional["FeedbackService"] = None
    feedback_max_attempts: int = 3
    feedback_timeout_ms: int = 10000
    environment: Optional[str] = None
    config: Optional[SignedConfigOptions] = None
    exposures: Optional[ExposureOptions] = None

EventProperties = Dict[str, Any]

FeedbackCategory = Literal['bug', 'feature', 'general']
FeedbackStatus = Literal['open', 'planned', 'in_progress', 'done', 'closed']

@dataclass
class FeedbackSubmission:
    title: str
    body: str
    category: FeedbackCategory
    priority: Optional[Literal['low', 'medium', 'high']] = None
    tags: Optional[List[str]] = None
    attachments: Optional[List[str]] = None
    score: Optional[int] = None
    product_area: Optional[str] = None

@dataclass
class FeedbackItem:
    id: str
    title: str
    body: str
    category: FeedbackCategory
    status: FeedbackStatus
    votes: int
    created_at: str

MessageKind = Literal['banner', 'modal', 'tooltip', 'inbox-item']

@dataclass
class MessageContent:
    body: str
    title: Optional[str] = None
    cta_text: Optional[str] = None
    cta_url: Optional[str] = None
    cta_action: Optional[Literal['link', 'dismiss', 'custom']] = None
    image_url: Optional[str] = None

@dataclass
class CampaignTrigger:
    type: Literal['url_match', 'event', 'manual']
    pattern: Optional[str] = None

@dataclass
class CampaignCaps:
    global_cap: Optional[int] = None
    session_cap: Optional[int] = None

@dataclass
class Campaign:
    id: str
    kind: MessageKind
    content: MessageContent
    triggers: List[CampaignTrigger]
    enabled: bool
    segment_id: Optional[str] = None
    priority: Optional[int] = None
    caps: Optional[CampaignCaps] = None

QuestionType = Literal['nps', 'csat', 'text', 'choice']

@dataclass
class QuestionChoice:
    label: str
    value: Any

@dataclass
class Question:
    id: str
    type: QuestionType
    title: str
    description: Optional[str] = None
    choices: Optional[List[QuestionChoice]] = None
    min: Optional[int] = None
    max: Optional[int] = None
    required: Optional[bool] = None

@dataclass
class SurveyCaps:
    global_cap: Optional[int] = None

@dataclass
class Survey:
    id: str
    questions: List[Question]
    triggers: List[CampaignTrigger]
    enabled: bool
    title: Optional[str] = None
    segment_id: Optional[str] = None
    caps: Optional[SurveyCaps] = None

@dataclass
class SurveyResponseAnswer:
    question_id: str
    value: Any

@dataclass
class SurveyResponse:
    survey_id: str
    answers: List[SurveyResponseAnswer]
    submitted_at: int


@dataclass
class FeedbackReceipt:
    id: str
    accepted: bool

@dataclass
class FeedbackContext:
    source: Literal['in_app']
    user: Optional[UserIdentity]
    idempotency_key: Optional[str] = None

class FeedbackService(Protocol):
    async def submit(self, feedback: FeedbackSubmission, context: FeedbackContext) -> FeedbackReceipt:
        """Return acceptance only after the backing service accepts the submission."""
        ...
