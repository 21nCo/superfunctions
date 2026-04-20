from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Mapping, Optional, Sequence

from .template import PromptTemplate, _normalize_values


@dataclass(frozen=True)
class FewShotPrompt:
    prefix: str
    examples: Sequence[Mapping[str, str]]
    suffix: str
    input_variables: Optional[Sequence[str]] = None
    example_separator: str = "\n\n"
    example_prompt: PromptTemplate = field(
        default_factory=lambda: PromptTemplate("Input: {input}\nOutput: {output}")
    )

    def format(self, values: Mapping[str, Any] | None = None, **kwargs: Any) -> str:
        payload = _normalize_values(values, **kwargs)
        suffix_prompt = PromptTemplate(self.suffix, variables=self.input_variables)
        prefix_prompt = PromptTemplate(self.prefix)

        sections = [prefix_prompt.format(payload)]
        example_blocks = [self.example_prompt.format(example) for example in self.examples]
        if example_blocks:
            sections.append(self.example_separator.join(example_blocks))
        sections.append(suffix_prompt.format(payload))
        return self.example_separator.join(sections)
