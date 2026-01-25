import { ChatModel } from "./base.js";
import { ChatRequest, ChatResponse, CompletionRequest, CompletionResponse, StreamEvent } from "../core/types.js";

export class MockChatModel extends ChatModel {
  provider = "mock";
  model = "mock-1";

  constructor(private responses: string[] = []) {
    super();
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const content = this.responses.shift() || request.prompt;
    return { content, raw: { mock: true } };
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const content = this.responses.shift() || JSON.stringify({ echo: request.messages });
    return {
      message: { role: "assistant", content },
      raw: { mock: true }
    };
  }

  async *stream(request: CompletionRequest): AsyncIterable<StreamEvent> {
    const content = this.responses.shift() || request.prompt;
    yield { type: "content", content, delta: content };
    yield { type: "end", finish_reason: "stop" };
  }
}
