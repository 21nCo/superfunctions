import pytest

from langfn.prompts import ChatTemplate, PromptTemplate
from langfn.prompts.chat_template import ChatMessageTemplate


def test_prompt_template_format():
    t = PromptTemplate(template="Hello {name}!", variables=["name"])
    assert t.format({"name": "Alice"}) == "Hello Alice!"


def test_prompt_template_missing_raises():
    t = PromptTemplate(template="Hello {name}!", variables=["name"])
    with pytest.raises(KeyError):
        t.format({})


def test_chat_template_format():
    chat = ChatTemplate(
        messages=[
            ChatMessageTemplate(role="system", content="You are a {role}."),
            ChatMessageTemplate(role="user", content="{q}"),
        ]
    )
    assert chat.format({"role": "helper", "q": "hi"}) == [
        {"role": "system", "content": "You are a helper."},
        {"role": "user", "content": "hi"},
    ]

