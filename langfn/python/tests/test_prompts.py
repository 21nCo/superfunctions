import pytest

from langfn.core.errors import ValidationError
from langfn.prompts import ChatTemplate, FewShotPrompt, PromptTemplate


def test_prompt_template_renders_deterministically():
    template = PromptTemplate("Hello {name}")
    assert template.format(name="Alice") == "Hello Alice"
    assert template.format({"name": "Alice"}) == "Hello Alice"


def test_prompt_template_missing_variables_raise_canonical_validation_error():
    template = PromptTemplate("Hello {name}")
    with pytest.raises(ValidationError) as error:
        template.format({})
    assert error.value.code == "VALIDATION_ERROR"
    assert error.value.metadata["missing"] == ["name"]


def test_chat_template_preserves_order_and_content():
    chat = ChatTemplate.from_messages(
        [("system", "You are a {role}."), ("user", "{question}")]
    )

    assert chat.format_messages(role="helper", question="Hi") == [
        {"role": "system", "content": "You are a helper."},
        {"role": "user", "content": "Hi"},
    ]


def test_few_shot_prompt_preserves_example_order_and_separator():
    prompt = FewShotPrompt(
        prefix="Translate",
        examples=[{"input": "Hello", "output": "Bonjour"}],
        suffix="Input: {input}",
    )

    assert prompt.format(input="Goodbye") == "Translate\n\nInput: Hello\nOutput: Bonjour\n\nInput: Goodbye"
