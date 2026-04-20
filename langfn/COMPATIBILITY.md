# LangFn Provider Compatibility

LangFn `0.1.0` supports the following first-party providers in both TypeScript and Python.

| Provider | completion | chat | streaming | tools | embeddings | evaluation | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| openai | yes | yes | yes | yes | yes | yes | Native streamed chat completions plus first-party embeddings. |
| anthropic | yes | yes | yes | yes | no | yes | Native streamed messages API with tool-use support. |
| ollama | yes | yes | yes | no | no | yes | Local model adapter; streaming is supported, tool mapping is not first-party. |
| google | yes | yes | yes | no | no | yes | Streaming is compatibility-mode via the current chat surface. |
| mistral | yes | yes | yes | yes | no | yes | Tool-call mapping is supported on chat completions. |

## Notes

- Evaluation support means the provider can be exercised through `LangFn` evaluators once the model is configured.
- `custom` and `mock` remain available for SPI and deterministic test flows, but they are not part of the first-party release matrix above.
- Only OpenAI ships a first-party embeddings adapter in `0.1.0`.
