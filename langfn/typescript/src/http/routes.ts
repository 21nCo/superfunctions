import { Route } from "@superfunctions/http";
import { LangFn } from "../client.js";

export function createLangFnRouter(lang: LangFn): Route[] {
  return [
    {
      method: "GET",
      path: "/health",
      handler: async () => {
        return new Response(
          JSON.stringify({ status: "ok", name: "langfn", version: "0.1.0" }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
    },
    {
      method: "POST",
      path: "/complete",
      handler: async (request) => {
        const body = await request.json();
        const result = await lang.complete(body.prompt, { metadata: body.metadata });
        return new Response(
          JSON.stringify({
            content: result.content,
            trace_id: result.trace_id,
            usage: result.usage
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
    },
    {
      method: "POST",
      path: "/chat",
      handler: async (request) => {
        const body = await request.json();
        const result = await lang.chat(body.messages, {
          tools: body.tools,
          tool_choice: body.tool_choice,
          metadata: body.metadata
        });
        return new Response(
          JSON.stringify({
            message: result.message,
            tool_calls: result.tool_calls,
            trace_id: result.trace_id,
            usage: result.usage
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
    }
  ];
}
