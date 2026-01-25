from __future__ import annotations

from typing import Any, Dict, List, Optional


class FewShotPrompt:
    def __init__(
        self,
        *,
        prefix: str,
        examples: List[Dict[str, str]],
        suffix: str,
        input_variables: List[str],
        example_separator: str = "\n\n",
    ):
        self._prefix = prefix
        self._examples = examples
        self._suffix = suffix
        self._input_variables = input_variables
        self._example_separator = example_separator

    def format(self, **kwargs: Any) -> str:
        example_strs = []
        for example in self._examples:
            # Simple format for examples
            ex_str = f"Input: {example.get('input', '')}\nOutput: {example.get('output', '')}"
            example_strs.append(ex_str)
            
        examples_formatted = self._example_separator.join(example_strs)
        
        res = f"{self._prefix}{self._example_separator}{examples_formatted}{self._example_separator}{self._suffix}"
        
        for k, v in kwargs.items():
            res = res.replace(f"{{{k}}}", str(v))
            
        return res
