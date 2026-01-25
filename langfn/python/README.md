# LangFn (Python)

Comprehensive AI Development SDK for LLM-based workflows.

## Features

- **Model Abstraction**: Unified interface for OpenAI, Anthropic, Ollama, and more.
- **Orchestration**: Sequential, Parallel, and Map-Reduce chains.
- **Graph Workflows**: Stateful workflows with `StateGraph`.
- **Agents**: Functional `ToolAgent` and `ReActAgent`.
- **Structured Output**: Type-safe output parsing with Pydantic.
- **RAG**: Embeddings and Vector Store support.
- **Observability**: Built-in tracing with `watchfn` integration.

## Usage

```python
from langfn import LangFn
from langfn.models.openai import OpenAIChatModel

lang = LangFn(
    model=OpenAIChatModel(api_key="your-api-key")
)

response = await lang.complete("Hello world")
print(response.content)
```

## Documentation

See the [main documentation](https://docs.superfunctions.dev/langfn) for more details.