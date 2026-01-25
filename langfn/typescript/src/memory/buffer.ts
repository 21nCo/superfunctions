import { Message } from "../core/types.js";

export class BufferMemory {
  private messages: Message[] = [];
  private maxMessages: number;

  constructor(options: { maxMessages?: number } = {}) {
    this.maxMessages = options.maxMessages ?? 10;
  }

  async add(message: Message): Promise<void> {
    this.messages.push(message);
    if (this.messages.length > this.maxMessages) {
      this.messages = this.messages.slice(-this.maxMessages);
    }
  }

  async extend(messages: Message[]): Promise<void> {
    for (const msg of messages) {
      await this.add(msg);
    }
  }

  async get(): Promise<Message[]> {
    return [...this.messages];
  }

  async clear(): Promise<void> {
    this.messages = [];
  }
}
