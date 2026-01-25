import { z } from "zod";
import { LangFn } from "../client.js";
import { Tool } from "../tools/base.js";
import { Message } from "../core/types.js";

export interface ReActResult {
  messages: Message[];
  output: string;
}

export class ReActAgent {
  constructor(
    private options: {
      model: LangFn;
      tools: Tool<any, any>[];
      max_iterations?: number;
      system_prompt?: string;
    }
  ) {}

  async run(prompt: string): Promise<ReActResult> {
    const max_iterations = this.options.max_iterations ?? 10;
    const system_prompt = this.options.system_prompt ?? "You are a helpful assistant with access to tools. Use them to answer the user's request.";
    
    const messages: Message[] = [
      { role: "system", content: system_prompt },
      { role: "user", content: prompt }
    ];

    const tool_map = Object.fromEntries(this.options.tools.map(t => [t.name, t]));

    for (let i = 0; i < max_iterations; i++) {
      const resp = await this.options.model.chat(messages, {
        tools: this.options.tools,
        tool_choice: "auto"
      });

      const assistant_msg = resp.message;
      if (resp.tool_calls) {
        // In a real implementation, we'd need to handle the assistant message with tool_calls in history
        // This is a simplified version
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
        let result_content: string;
        if (!tool) {
          result_content = JSON.stringify({ error: `Tool ${call.name} not found` });
        } else {
          try {
            const result = await tool.run(call.arguments);
            result_content = typeof result === "string" ? result : JSON.stringify(result);
          } catch (e: any) {
            result_content = JSON.stringify({ error: e.message });
          }
        }

        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: result_content
        });
      }
    }

    return {
      messages,
      output: "I could not complete the task within the maximum number of steps."
    };
  }
}
