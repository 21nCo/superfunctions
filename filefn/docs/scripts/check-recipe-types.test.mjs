import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { RECIPES, checkRecipe, extractBlocks } from "./check-recipe-types.mjs";

const repoRoot = resolve(import.meta.dirname, "../../..");
const [workersRecipe, datafnRecipe] = RECIPES;
const read = (recipe) => readFileSync(resolve(repoRoot, recipe.file), "utf8");

for (const recipe of RECIPES) {
  test(`${recipe.file}: every TypeScript block typechecks`, () => {
    const { blocks, diagnostics } = checkRecipe(recipe);
    assert.ok(blocks.length > 0);
    assert.deepEqual(diagnostics, []);
  });
}

test("the DataFn recipe uses @filefn/client's real API", () => {
  const markdown = read(datafnRecipe);
  assert.match(markdown, /createFileFnClient\(/);
  assert.doesNotMatch(markdown, /filefnClient/);
  // A call the client does not have, as the recipe had before, is a type error.
  const broken = markdown.replace("files.uploadFile({", "files.upload({");
  assert.notEqual(broken, markdown);
  const { diagnostics } = checkRecipe(datafnRecipe, broken);
  assert.ok(diagnostics.some((d) => d.includes("TS2339") && d.includes("'upload'")), diagnostics.join("\n"));
});

test("the Workers recipe's browser block is checked with DOM types and its Worker blocks with workers types", () => {
  const markdown = read(workersRecipe);
  const blocks = extractBlocks(markdown);
  assert.deepEqual(blocks.filter((b) => b.browser).map((b) => b.path), ["src/files-client.ts"]);
  assert.ok(blocks.some((b) => !b.browser && b.path === "src/worker.ts"));
  // A Worker handler that does not match ExportedHandler<Env> is a type error.
  const broken = markdown.replace("async queue(batch, env) {", "async queue(batch: string, env) {");
  assert.notEqual(broken, markdown);
  assert.ok(checkRecipe(workersRecipe, broken).diagnostics.length > 0);
});

test("block paths come from a leading path comment; duplicate paths are reported", () => {
  const markdown = [
    "```ts", "// src/a.ts (browser)", "export const a = 1;", "```",
    "```typescript", "const b: number = 2;", "```",
    "```tsx", "<div />", "```",
  ].join("\n");
  assert.deepEqual(
    extractBlocks(markdown).map(({ path, browser, line }) => ({ path, browser, line })),
    [{ path: "src/a.ts", browser: true, line: 2 }, { path: "block-line-6.ts", browser: false, line: 6 }],
  );
  const duplicate = "```ts\n// src/a.ts\nexport const a = 1;\n```\n```ts\n// src/a.ts\nexport const b = 2;\n```\n";
  const { diagnostics } = checkRecipe({ ...workersRecipe, file: "virtual.md", stubs: {} }, duplicate);
  assert.ok(diagnostics.some((d) => d.includes("is also the path of the block at line 2")), diagnostics.join("\n"));
});
