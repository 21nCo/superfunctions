/**
 * Java OkHttp snippet target
 */

import type { OperationObject, SnippetOptions } from "@apifn/core";
import { buildContext } from "../context.js";

export function generateJavaOkhttp(
    operation: OperationObject,
    apiPath: string,
    method: string,
    options: SnippetOptions
): string {
    const ctx = buildContext(operation, apiPath, method, options);
    const ind = ctx.indent;
    const m = method.toUpperCase();
    const lines: string[] = [];

    lines.push("import okhttp3.*;");
    lines.push("");
    lines.push("OkHttpClient client = new OkHttpClient();");
    lines.push("");

    const allHeaders = { ...ctx.headers };

    if (ctx.body) {
        const escaped = ctx.body.replace(/"/g, '\\"');
        lines.push(`MediaType mediaType = MediaType.parse("application/json");`);
        lines.push(`RequestBody body = RequestBody.create("${escaped}", mediaType);`);
        lines.push("");
    }

    lines.push("Request request = new Request.Builder()");
    lines.push(`${ind}.url("${ctx.url}")`);

    for (const [k, v] of Object.entries(allHeaders)) {
        lines.push(`${ind}.addHeader("${k}", "${v}")`);
    }

    if (ctx.body) {
        lines.push(`${ind}.method("${m}", body)`);
    } else if (m === "GET") {
        lines.push(`${ind}.get()`);
    } else if (m === "DELETE") {
        lines.push(`${ind}.delete()`);
    } else {
        lines.push(`${ind}.method("${m}", RequestBody.create("", null))`);
    }

    lines.push(`${ind}.build();`);
    lines.push("");
    lines.push("try (Response response = client.newCall(request).execute()) {");
    lines.push(`${ind}System.out.println(response.body().string());`);
    lines.push("}");

    return lines.join("\n");
}
