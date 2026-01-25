import { LangFn } from "../client.js";

export async function* toSSE(lang: LangFn, prompt: string): AsyncIterable<string> {
  for await (const event of lang.stream(prompt)) {
    yield `data: ${JSON.stringify(event)}\n\n`;
  }
}
