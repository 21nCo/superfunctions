import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { RECIPES, checkRecipe, extractBlocks } from "./check-recipe-types.mjs";

const ts = createRequire(import.meta.url)("typescript");

const repoRoot = resolve(import.meta.dirname, "../../..");
const [workersRecipe, datafnRecipe] = RECIPES;
const read = (recipe) => readFileSync(resolve(repoRoot, recipe.file), "utf8");

/** Runs a recipe block that imports only packages, resolved from the docs package. */
async function importBlock(markdown, path) {
  const block = extractBlocks(markdown).find((b) => b.path === path);
  assert.ok(block, `no ${path} block`);
  const { outputText } = ts.transpileModule(block.code, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  const code = outputText.replace(/(from\s+)"([^".][^"]*)"/g, (_, from, specifier) => `${from}"${import.meta.resolve(specifier)}"`);
  const dir = mkdtempSync(join(tmpdir(), "filefn-recipe-"));
  try {
    const file = join(dir, "block.mjs");
    writeFileSync(file, code);
    return await import(pathToFileURL(file).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

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

test("the Workers recipe gives an API key only the FileFn access its scopes grant", async () => {
  const { resolveFileFnPrincipal } = await importBlock(read(workersRecipe), "src/auth.ts");
  const authWith = (session) => ({ provider: { authenticate: async () => session }, authorizeMutation: async () => session });
  const user = { type: "session", actorId: "user-1", tenantId: "tenant-1", scopes: ["*"] };
  const key = (scopes) => ({ type: "api-key", credential: { type: "api-key", id: "key-1" }, actorId: "user-1", tenantId: "tenant-1", scopes });
  const call = (session, method) => resolveFileFnPrincipal(authWith(session), new Request("https://app.example/files/f", { method }));
  const forbidden = { name: "FileFnError", code: "FILEFN_FORBIDDEN", status: 403 };

  const principal = { principalId: "user-1", tenantId: "tenant-1" };
  assert.deepEqual(await call(user, "GET"), principal);
  assert.deepEqual(await call(user, "POST"), principal);
  assert.equal(await call(null, "GET"), null);
  // A key created without scopes grants nothing, not its owner's access.
  await assert.rejects(call(key([]), "GET"), forbidden);
  await assert.rejects(call(key([]), "DELETE"), forbidden);
  assert.deepEqual(await call(key(["files:read"]), "HEAD"), principal);
  await assert.rejects(call(key(["files:read"]), "POST"), forbidden);
  await assert.rejects(call(key(["other:write"]), "PUT"), forbidden);
  assert.deepEqual(await call(key(["files:*"]), "DELETE"), principal);
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
