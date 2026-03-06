/**
 * C# HttpClient snippet target
 */

import type { OperationObject, SnippetOptions } from "@apifn/core";
import { buildContext } from "../context.js";

export function generateCsharpHttpclient(
    operation: OperationObject,
    apiPath: string,
    method: string,
    options: SnippetOptions
): string {
    const ctx = buildContext(operation, apiPath, method, options);
    const ind = ctx.indent;
    const m = method.charAt(0).toUpperCase() + method.slice(1).toLowerCase();
    const lines: string[] = [];

    lines.push("using System.Net.Http;");
    lines.push("using System.Text;");
    lines.push("using System.Text.Json;");
    lines.push("");
    lines.push("using var client = new HttpClient();");
    lines.push("");

    const allHeaders = { ...ctx.headers };
    for (const [k, v] of Object.entries(allHeaders)) {
        lines.push(`client.DefaultRequestHeaders.Add("${k}", "${v}");`);
    }

    if (ctx.body) {
        lines.push(`var content = new StringContent(`);
        lines.push(`${ind}"${ctx.body.replace(/"/g, '\\"')}",`);
        lines.push(`${ind}Encoding.UTF8,`);
        lines.push(`${ind}"application/json"`);
        lines.push(");");
        lines.push("");
        if (m === "Post" || m === "Put" || m === "Patch") {
            lines.push(`var response = await client.${m}Async("${ctx.url}", content);`);
        } else {
            lines.push(`var response = await client.${m}Async("${ctx.url}");`);
        }
    } else {
        lines.push(`var response = await client.${m}Async("${ctx.url}");`);
    }

    lines.push("");
    lines.push("var body = await response.Content.ReadAsStringAsync();");
    lines.push("Console.WriteLine(body);");

    return lines.join("\n");
}
