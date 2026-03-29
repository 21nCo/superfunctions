import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export async function GET(
  _request: Request,
  context: { params: Promise<{ slug: string[] }> },
) {
  const { slug } = await context.params;
  if (!Array.isArray(slug) || slug.length === 0 || slug.some((segment) => segment === "..")) {
    return new Response("Not found", { status: 404 });
  }

  const filePath = resolve(process.cwd(), "content", "docs", ...slug);

  try {
    const markdown = await readFile(filePath, "utf-8");
    return new Response(markdown, {
      headers: {
        "content-type": "text/markdown; charset=utf-8",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
