from .chat_template import ChatTemplate
from .few_shot import FewShotPrompt
from .template import PromptTemplate

ChatPromptTemplate = ChatTemplate

try:
    from .registry import PromptRegistry
except ModuleNotFoundError:  # pragma: no cover - optional shared DB dependency at import time
    PromptRegistry = None  # type: ignore[assignment]

__all__ = [
    "ChatPromptTemplate",
    "ChatTemplate",
    "FewShotPrompt",
    "PromptRegistry",
    "PromptTemplate",
]
