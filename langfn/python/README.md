# LangFn (Python)

LangFn for Python ships the canonical `langfn` package with the same workflow surface area as the TypeScript SDK, adapted to Python naming conventions.

Current release target: `0.1.0`.

## Install

```bash
pip install langfn==0.1.0
```

TypeScript users in the same release line install:

```bash
npm install langfn@0.1.0
```

## Supported imports

```python
from langfn import LangFn, create_http_routes
from langfn.models import OpenAIChatModel, MockChatModel
from langfn.prompts import PromptTemplate, ChatTemplate
from langfn.observability import Tracer, CostMeter, Budgets
from langfn.mcp import MCPClient, MCPServer
```

## Quick start

```python
import asyncio

from langfn import LangFn
from langfn.models import MockChatModel
from langfn.prompts import PromptTemplate


async def main() -> None:
    client = LangFn(model=MockChatModel(responses=["Hello Ada"]))
    prompt = PromptTemplate(template="Say hi to {name}", variables=["name"])
    response = await client.complete(prompt.format({"name": "Ada"}))
    print(response.content)


asyncio.run(main())
```

## Release checks

From the repository root:

```bash
python3 -m pytest langfn/python/tests -q
npm run gate:langfn-release
```

## Compatibility

See [../COMPATIBILITY.md](../COMPATIBILITY.md) for first-party provider support across completion, chat, streaming, tools, embeddings, and evaluation.
