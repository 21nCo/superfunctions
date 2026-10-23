from __future__ import annotations

from typing import List, Union

try:
    import tiktoken
except ImportError:
    tiktoken = None


def count_tokens(text: str, model: str = "gpt-4") -> int:
    if tiktoken is None:
        # Simple fallback estimation: ~4 chars per token
        return len(text) // 4

    try:
        encoding = tiktoken.encoding_for_model(model)
    except KeyError:
        encoding = tiktoken.get_encoding("cl100k_base")
        
    return len(encoding.encode(text))


def count_messages_tokens(messages: List[dict], model: str = "gpt-4") -> int:
    if tiktoken is None:
        return sum(len(m.get("content", "")) for m in messages) // 4

    try:
        encoding = tiktoken.encoding_for_model(model)
    except KeyError:
        encoding = tiktoken.get_encoding("cl100k_base")

    tokens_per_message = 3
    tokens_per_name = 1
    
    num_tokens = 0
    for message in messages:
        num_tokens += tokens_per_message
        for key, value in message.items():
            num_tokens += len(encoding.encode(str(value)))
            if key == "name":
                num_tokens += tokens_per_name
    num_tokens += 3  # every reply is primed with <|start|>assistant<|message|>
    return num_tokens
