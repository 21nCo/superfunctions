import { Message } from "../core/types.js";
import { LangFn } from "../client.js";

export class SummaryMemory {
  private messages: Message[] = [];
  private summary?: string;
  private maxTokens: number;
  private summaryPrompt: string;

  constructor(
    private readonly lang: LangFn,
    options: { maxTokens?: number, summaryPrompt?: string } = {}
  ) {
    this.maxTokens = options.maxTokens ?? 2000;
    this.summaryPrompt = options.summaryPrompt ?? "Summarize the following conversation history concisely, retaining all key information:";
  }

  async add(message: Message): Promise<void> {
    this.messages.push(message);
    if (this.messages.length > 10) {
      await this.summarize();
    }
  }

  private async summarize(): Promise<void> {
    const history = this.messages.map(m => `${m.role}: ${m.content}`).join("\n");
    const prompt = `${this.summaryPrompt}\n\nExisting Summary: ${this.summary || 'None'}\n\nNew Messages:\n${history}`;
    
    const response = await this.lang.complete(prompt);
    this.summary = response.content;
    this.messages = [];
  }

  async get(): Promise<Message[]> {
    const history: Message[] = [];
    if (this.summary) {
      history.push({ role: "system", content: `Previous conversation summary: ${this.summary}` });
    }
    history.push(...this.messages);
    return history;
  }

  async clear(): Promise<void> {
    this.messages = [];
    this.summary = undefined;
  }
}
