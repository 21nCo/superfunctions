/**
 * PHP cURL snippet target
 */

import type { OperationObject, SnippetOptions } from "@apifn/core";
import { buildContext } from "../context.js";

export function generatePhpCurl(
    operation: OperationObject,
    apiPath: string,
    method: string,
    options: SnippetOptions
): string {
    const ctx = buildContext(operation, apiPath, method, options);
    const ind = ctx.indent;
    const m = method.toUpperCase();
    const lines: string[] = [];

    lines.push("<?php");
    lines.push("");
    lines.push(`$ch = curl_init('${ctx.url}');`);

    const allHeaders = { ...ctx.headers };
    if (ctx.body) allHeaders["Content-Type"] = "application/json";

    lines.push(`curl_setopt($ch, CURLOPT_CUSTOMREQUEST, '${m}');`);
    lines.push("curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);");

    if (Object.keys(allHeaders).length > 0) {
        lines.push("curl_setopt($ch, CURLOPT_HTTPHEADER, [");
        for (const [k, v] of Object.entries(allHeaders)) {
            lines.push(`${ind}'${k}: ${v}',`);
        }
        lines.push("]);");
    }

    if (ctx.body) {
        lines.push(`curl_setopt($ch, CURLOPT_POSTFIELDS, '${ctx.body.replace(/'/g, "\\'")}');`);
    }

    lines.push("");
    lines.push("$response = curl_exec($ch);");
    lines.push("curl_close($ch);");
    lines.push("");
    lines.push("echo $response;");

    return lines.join("\n");
}
