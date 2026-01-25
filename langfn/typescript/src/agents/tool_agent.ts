import { LangFn } from "../client.js";
import { Tool } from "../tools/base.js";
import { Message } from "../core/types.js";

export interface ToolAgentResult {
  messages: Message[];
  output: string;
}

export class ToolAgent {
  constructor(
    private options: {
      lang: LangFn;
      tools: Tool<any, any>[];
      max_iterations?: number;
    }
  ) {}

  async run(prompt: string, options: { system?: string } = {}): Promise<ToolAgentResult> {
    const max_iterations = this.options.max_iterations ?? 5;
    const messages: Message[] = [];
    if (options.system) {
      messages.push({ role: "system", content: options.system });
    }
    messages.push({ role: "user", content: prompt });

    const tool_map = Object.fromEntries(this.options.tools.map(t => [t.name, t]));

    for (let i = 0; i < max_iterations; i++) {
      const resp = await this.options.lang.chat(messages, {
        tools: this.options.tools
      });

      const assistant_msg = resp.message;
      if (resp.tool_calls) {
        (assistant_msg as any).tool_calls = resp.tool_calls.map(c => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: JSON.stringify(c.arguments) }
        }));
      }
      messages.push(assistant_msg);

      if (!resp.tool_calls || resp.tool_calls.length === 0) {
        return { messages, output: resp.message.content };
      }

      for (const call of resp.tool_calls) {
        const tool = tool_map[call.name];
        if (!tool) throw new Error(`Unknown tool: ${call.name}`);
        
        const result = await tool.run(call.arguments);
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(result)
        });
      }
    }

    throw new Error("Max iterations exceeded");
  }
}
