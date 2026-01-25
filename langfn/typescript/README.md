# LangFn (TypeScript)

Comprehensive AI Development SDK for LLM-based workflows.

## Features

- **Model Abstraction**: Unified interface for OpenAI, Anthropic, Ollama, and more.
- **Orchestration**: Sequential, Parallel, and Map-Reduce chains.
- **Graph Workflows**: Stateful workflows with `StateGraph`.
- **Agents**: Functional `ToolAgent` and `ReActAgent`.
- **Structured Output**: Type-safe output parsing with Zod.
- **RAG**: Embeddings and Vector Store support.
- **Observability**: Built-in tracing.

## Usage

```typescript
import { langfn, models } from "langfn";

const lang = langfn({
  model: new models.OpenAIChatModel({
    apiKey: process.env.OPENAI_API_KEY
  })
});

const response = await lang.complete("Hello world");
console.log(response.content);
```

## Documentation

See the [main documentation](https://docs.superfunctions.dev/langfn) for more details.
