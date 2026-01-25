import { ChatRequest, ChatResponse, CompletionRequest, CompletionResponse, StreamEvent } from "../core/types.js";

export abstract class ChatModel {
  abstract provider: string;
  abstract model: string;

  abstract complete(request: CompletionRequest): Promise<CompletionResponse>;
  abstract chat(request: ChatRequest): Promise<ChatResponse>;
  abstract stream(request: CompletionRequest): AsyncIterable<StreamEvent>;
}
