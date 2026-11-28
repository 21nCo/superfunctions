import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { RECIPES, checkRecipe, extractBlocks } from "./check-recipe-types.mjs";

const ts = createRequire(import.meta.url)("typescript");

const repoRoot = resolve(import.meta.dirname, "../../..");
const [workersRecipe, datafnRecipe] = RECIPES;
const read = (recipe) => readFileSync(resolve(repoRoot, recipe.file), "utf8");

/**
 * Imports a recipe block as a module, with the page's blocks it imports. A package
 * resolves from the docs package unless `fakes` maps its name to module source.
 */
async function importBlock(markdown, path, fakes = {}) {
  const blocks = extractBlocks(markdown);
  assert.ok(blocks.some((b) => b.path === path), `no ${path} block`);
  const dir = mkdtempSync(join(tmpdir(), "filefn-recipe-"));
  const moduleFile = (blockPath) => join(dir, blockPath.replace(/\.ts$/, ".mjs"));
  const fakeUrls = {};
  for (const [index, [name, source]] of Object.entries(fakes).entries()) {
    writeFileSync(join(dir, `fake-${index}.mjs`), source);
    fakeUrls[name] = pathToFileURL(join(dir, `fake-${index}.mjs`)).href;
  }
  const resolveSpecifier = (specifier) => {
    if (specifier.startsWith(".")) return `${specifier}.mjs`;
    if (fakeUrls[specifier]) return fakeUrls[specifier];
    try {
      return import.meta.resolve(specifier);
    } catch {
      return specifier; // Only blocks that are imported must resolve.
    }
  };
  try {
    for (const block of blocks) {
      const { outputText } = ts.transpileModule(block.code, {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      });
      mkdirSync(dirname(moduleFile(block.path)), { recursive: true });
      writeFileSync(moduleFile(block.path), outputText.replace(/(from\s+)"([^"]+)"/g, (_, from, specifier) => `${from}"${resolveSpecifier(specifier)}"`));
    }
    return await import(pathToFileURL(moduleFile(path)).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Runs `run` with the given globals defined, then restores the previous ones. */
async function withGlobals(globals, run) {
  const previous = Object.fromEntries(Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  try {
    return await run();
  } finally {
    for (const [name, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
}

/** `@filefn/client` whose `createFileFnClient` returns `globalThis.fakeFiles`. */
const fakeFileFnClient = "export const createFileFnClient = (options) => Object.assign(globalThis.fakeFiles, { options });";
const fakeDatafnClient = "export const createDatafnClient = (options) => ({ options });";

function memoryStorage() {
  const items = new Map();
  return { getItem: (key) => items.get(key) ?? null, setItem: (key, value) => items.set(key, String(value)) };
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

test("the Workers recipe's AuthFn accepts a real API key only within its scopes", async () => {
  const { createAuth, scopes, resolveFileFnPrincipal } = await importBlock(read(workersRecipe), "src/auth.ts");
  const { memoryAdapter } = await import("@superfunctions/db/adapters/memory");
  const { createApiKey } = await import("authfn/core/api-keys");
  const database = memoryAdapter({ debug: false });
  const auth = createAuth(database);
  assert.ok(auth.getSchema().schemas.some((schema) => schema.modelName === "api_keys"), "the api-keys plugin is installed");
  const create = (keyScopes) => createApiKey({ database, namespace: "authfn", scopes }, { userId: null, name: "test-key", scopes: keyScopes });
  const call = (secret, method) => resolveFileFnPrincipal(auth, new Request("https://app.example/files/f", { method, headers: { authorization: `Bearer ${secret}` } }));
  const forbidden = { code: "FILEFN_FORBIDDEN", status: 403 };

  const reader = await create(["files:read"]);
  assert.deepEqual(await call(reader.secret, "GET"), { principalId: reader.keyId, tenantId: undefined });
  await assert.rejects(call(reader.secret, "POST"), forbidden);
  const writer = await create(["files:*"]);
  assert.equal((await call(writer.secret, "DELETE"))?.principalId, writer.keyId);
  await assert.rejects(call((await create(undefined)).secret, "GET"), forbidden);
  await assert.rejects(create(["other:read"]), /scope/i);
});

test("the Workers recipe checks a device thumbnail's type before uploading the photo", async () => {
  const calls = [];
  const fakeFiles = {
    uploadFile: (input) => (calls.push(["uploadFile", input.policy]), { done: async () => ({ fileId: "file-1", versionId: "version-1" }) }),
    uploadArtifact: async (input) => {
      calls.push(["uploadArtifact", input.mimeType]);
      throw new Error("artifact upload failed");
    },
  };
  const globals = { fakeFiles, location: { origin: "https://app.example" }, document: { cookie: "authfn.csrf=test-csrf" } };
  await withGlobals(globals, async () => {
    const { files, uploadPhoto } = await importBlock(read(workersRecipe), "src/files-client.ts", { "@filefn/client": fakeFileFnClient });
    assert.deepEqual(await files.options.getAuthHeaders(), { "x-authfn-csrf": "test-csrf" });
    const photo = new File(["photo"], "photo.jpg", { type: "image/jpeg" });
    await assert.rejects(uploadPhoto(photo, new Blob(["thumb"])), TypeError);
    assert.deepEqual(calls, [], "nothing is uploaded for an untyped thumbnail");
    const warn = console.warn;
    console.warn = () => {};
    try {
      // A failed thumbnail upload still returns the stored photo.
      assert.equal(await uploadPhoto(photo, new Blob(["thumb"], { type: "image/webp" })), "file-1");
    } finally {
      console.warn = warn;
    }
    assert.deepEqual(calls, [["uploadFile", "photos"], ["uploadArtifact", "image/webp"]]);
  });
});

test("the DataFn recipe keeps one client ID per installation and sends the CSRF header", async () => {
  const fakes = { "@filefn/client": fakeFileFnClient, "@datafn/client": fakeDatafnClient };
  const storage = memoryStorage();
  const load = (localStorage) => withGlobals({ fakeFiles: {}, localStorage, document: { cookie: "a=1; authfn.csrf=test-csrf" } }, () => importBlock(read(datafnRecipe), "clients.ts", fakes));
  const first = await load(storage);
  const reloaded = await load(storage);
  const other = await load(memoryStorage());
  assert.match(first.client.options.clientId, /^web-[\w-]{36}$/);
  assert.equal(reloaded.client.options.clientId, first.client.options.clientId);
  assert.notEqual(other.client.options.clientId, first.client.options.clientId);
  await withGlobals({ document: { cookie: "a=1; authfn.csrf=test-csrf" } }, async () => {
    assert.deepEqual(await first.files.options.getAuthHeaders(), { "x-authfn-csrf": "test-csrf" });
  });
});

test("the DataFn recipe authenticates bearer-only downloads with the token, and never sends it to storage", async () => {
  let storedUrl = "/proxy/files/file-1/download";
  const requests = [];
  const globals = {
    localStorage: memoryStorage(),
    document: { cookie: "" }, // No session cookie.
    fetch: async (url, init = {}) => {
      requests.push([String(url), new Headers(init.headers).get("authorization"), init.credentials]);
      if (String(url).endsWith("/files/file-1/download")) return Response.json({ ok: true, data: { url: storedUrl } });
      return new Response("bytes");
    },
    URL: Object.assign(class extends URL {}, { createObjectURL: () => "blob:test-object", revokeObjectURL: (url) => requests.push(["revoked", url]) }),
  };
  await withGlobals(globals, async () => {
    // The real @filefn/client transport, over the fetch above.
    const { showAttachmentWithToken } = await importBlock(read(datafnRecipe), "display.ts", { "@datafn/client": fakeDatafnClient });
    const img = { decode: async () => {} };
    await showAttachmentWithToken(img, { fileId: "file-1", filename: "a.png" }, "test-token");
    assert.equal(img.src, "blob:test-object");
    assert.deepEqual(requests, [
      ["/files/file-1/download", "Bearer test-token", "omit"],
      ["/files/proxy/files/file-1/download", "Bearer test-token", "omit"],
      ["revoked", "blob:test-object"],
    ]);
    storedUrl = "https://storage.example/signed";
    requests.length = 0;
    await showAttachmentWithToken(img, { fileId: "file-1", filename: "a.png" }, "test-token");
    assert.equal(img.src, "https://storage.example/signed");
    assert.deepEqual(requests, [["/files/file-1/download", "Bearer test-token", "omit"]], "a signed storage URL never receives the token");
  });
});

test("the DataFn recipe's CORS wrapper answers preflights for allowed origins only", async () => {
  const { withCors } = await importBlock(read(datafnRecipe), "cors.ts");
  const handled = [];
  const handle = withCors(async (request) => (handled.push(request.method), new Response("ok", { headers: { "x-filefn": "1" } })));
  const request = (origin, method = "GET", headers = {}) => new Request("https://files.example/files/f", { method, headers: { origin, ...headers } });
  const preflight = await handle(request("https://app.example.com", "OPTIONS", { "access-control-request-method": "PUT", "access-control-request-headers": "authorization" }));
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "https://app.example.com");
  assert.match(preflight.headers.get("access-control-allow-headers"), /authorization/);
  // Keyed uploads and offline replays send it: without it the browser blocks them at preflight.
  assert.match(preflight.headers.get("access-control-allow-headers"), /x-idempotency-key/);
  assert.match(preflight.headers.get("access-control-allow-methods"), /PUT/);
  assert.equal((await handle(request("https://evil.example", "OPTIONS", { "access-control-request-method": "PUT" }))).status, 403);
  const response = await handle(request("https://app.example.com"));
  assert.equal(await response.text(), "ok");
  assert.equal(response.headers.get("x-filefn"), "1");
  assert.equal(response.headers.get("access-control-allow-origin"), "https://app.example.com");
  assert.equal((await handle(request("https://evil.example"))).headers.get("access-control-allow-origin"), null);
  assert.deepEqual(handled, ["GET", "GET"], "preflights never reach FileFn");
});
