import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { authFnApiKeyPlugin } from '@authfn/api-keys';
import { createRouter } from '@superfunctions/http';
import { memoryAdapter } from '../../../../packages/db/src/adapters/memory/index.js';
import { AuthFnError, requireScopes, type AuthFnRuntimeConfig, type AuthFnServer, type AuthFnSession } from '../index.js';
import { createApiKey, revokeApiKeyById } from '../core/api-keys.js';
import { issueSession } from '../core/sessions.js';
import { createUser } from '../core/users.js';
import { createAuthFnRouter } from '../http/router.js';
import { createTestServer } from './test-server.js';

type Handler = (request: Request) => Promise<Response>;
type ProtectedWork = (request: Request) => Response;

const SCOPES = { repo: ['read', 'write'], projects: ['read', 'write'] } as const;
const PLUGIN_EXAMPLE = 'async function handleRepositoryRequest';
const CLI_EXAMPLE = "app.get('/projects'";

function createConfig(): AuthFnRuntimeConfig {
  return { database: memoryAdapter({ debug: false }), namespace: 'authfn', scopes: SCOPES, plugins: [authFnApiKeyPlugin()] };
}

function requiredScope(guide: 'plugin' | 'cli'): string {
  return guide === 'plugin' ? 'repo:read' : 'projects:read';
}

function readGuide(guide: 'plugin' | 'cli'): string {
  const path = guide === 'plugin' ? 'plugins/api-keys.md' : 'recipes/cli-auth.md';
  return readFileSync(new URL(`../../../docs/content/docs/${path}`, import.meta.url), 'utf8');
}

function readBlock(text: string, prefix: string): string {
  const block = [...text.matchAll(/```ts\n([\s\S]*?)```/g)]
    .map((match) => match[1])
    .find((code) => code.includes(prefix));
  if (!block) throw new Error(`Missing documented example: ${prefix}`);
  return block;
}

function compile(code: string): string {
  // The example's `authfn` import is checked by the typecheck test below and
  // injected as Function parameters here.
  const output = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } })
    .outputText.replace(/^export \{\};\s*$/gm, '');
  const imports = output.match(/^import .*$/gm) ?? [];
  expect(imports).toEqual(["import { AuthFnError, requireScopes } from 'authfn';"]);
  return output.replace(/^import .*$/gm, '');
}

function scopeExample(guide: 'plugin' | 'cli'): string {
  return readBlock(readGuide(guide), guide === 'plugin' ? PLUGIN_EXAMPLE : CLI_EXAMPLE);
}

function documentedHandler(guide: 'plugin' | 'cli', auth: AuthFnServer, protectedWork: ProtectedWork): Handler {
  if (guide === 'plugin') {
    return new Function('auth', 'handleAuthorizedRequest', 'AuthFnError', 'requireScopes', `${compile(scopeExample(guide))}\nreturn handleRepositoryRequest;`)(
      auth, protectedWork, AuthFnError, requireScopes
    );
  }

  type Context = { req: { raw: Request }; json: (data: unknown, status?: number) => Response };
  let handler: ((context: Context) => Promise<Response>) | undefined;
  const app = {
    get(_path: string, incoming: (context: Context) => Promise<Response>) {
      handler = incoming;
    }
  };
  new Function('app', 'auth', 'AuthFnError', 'requireScopes', compile(scopeExample(guide)))(app, auth, AuthFnError, requireScopes);
  return async (request) => {
    if (!handler) throw new Error('CLI example did not register its route');
    return handler({
      req: { raw: request },
      json(data, status = 200) {
        if (status === 200) protectedWork(request);
        return Response.json(data, { status });
      }
    });
  };
}

describe.each(['plugin', 'cli'] as const)('%s API-key documentation HTTP boundary', (guide) => {
  it.each([null, 'user:docs'])('distinguishes invalid credentials from valid keys at the host HTTP boundary (owner %s)', async (userId) => {
    const config = createConfig();
    const auth = createTestServer(config);
    const protectedWork = vi.fn(() => Response.json({ allowed: true }));
    const handler = documentedHandler(guide, auth, protectedWork);
    const onError = vi.fn(async () => Response.json({ error: 'internal' }, { status: 500 }));
    const router = createRouter({ basePath: '/app', routes: [{ method: 'GET', path: '/doc-example', handler }], onError });
    if (userId) await createUser(config, { id: userId, primaryEmail: 'docs@example.com' });
    const revoked = await createApiKey(config, { userId, name: 'revoked', scopes: ['repo:read', 'projects:read'] });
    await revokeApiKeyById(config, revoked.keyId);
    const expired = await createApiKey(config, { userId, name: 'expired', scopes: ['repo:read', 'projects:read'], expiresAt: new Date(0) });

    for (const authorization of [`Bearer ${revoked.secret}`, `Api-Key ${revoked.secret}`, `Bearer ${expired.secret}`, 'Bearer unknown-key', 'Basic invalid', undefined]) {
      const request = new Request('https://example.com/app/doc-example', {
        headers: authorization ? { authorization } : {}
      });
      const response = await router.handle(request);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'unauthorized' });
      expect(protectedWork).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
    }

    const valid = await createApiKey(config, { userId, name: 'valid-control', scopes: ['repo:read', 'projects:read'] });
    const response = await router.handle(new Request('https://example.com/app/doc-example', {
      headers: { authorization: `Bearer ${valid.secret}` }
    }));
    expect(response.status).toBe(200);
    expect(protectedWork).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it('propagates unexpected authentication and protected-handler failures to the host', async () => {
    const config = createConfig();
    const auth = createTestServer(config);
    const protectedWork = vi.fn(() => Response.json({ allowed: true }));
    const handler = documentedHandler(guide, auth, protectedWork);
    const onError = vi.fn(async (_error: unknown) => Response.json({ error: 'internal' }, { status: 500 }));
    const router = createRouter({ basePath: '/app', routes: [{ method: 'GET', path: '/doc-example', handler }], onError });
    const key = await createApiKey(config, { userId: null, name: 'valid', scopes: ['repo:read', 'projects:read'] });
    const request = () => new Request('https://example.com/app/doc-example', { headers: { authorization: `Bearer ${key.secret}` } });
    const failure = new Error('database unavailable');
    const database = vi.spyOn(config.database, 'findOne').mockRejectedValue(failure);
    try {
      await expect(handler(request())).rejects.toBe(failure);
      expect((await router.handle(request())).status).toBe(500);
      expect(onError.mock.calls[0]?.[0]).toBe(failure);
      expect(protectedWork).not.toHaveBeenCalled();
    } finally {
      database.mockRestore();
    }

    const applicationFailure = Object.assign(new Error('protected application work failed'), { code: 'AUTHFN_API_KEY_REVOKED' });
    protectedWork.mockImplementation(() => { throw applicationFailure; });
    await expect(handler(request())).rejects.toBe(applicationFailure);
    expect((await router.handle(request())).status).toBe(500);
    expect(onError.mock.calls[1]?.[0]).toBe(applicationFailure);
  });

  it.each([null, 'user:docs'])('grants exact, owner-wildcard and full scopes and returns 403 otherwise (owner %s)', async (userId) => {
    const config = createConfig();
    const auth = createTestServer(config);
    const protectedWork = vi.fn(() => Response.json({ allowed: true }));
    const handler = documentedHandler(guide, auth, protectedWork);
    const router = createAuthFnRouter(config, {}, [{ method: 'GET', path: '/doc-example', handler }]);
    const required = requiredScope(guide);
    const [owner] = required.split(':');
    const otherOwner = owner === 'repo' ? 'projects' : 'repo';
    if (userId) await createUser(config, { id: userId, primaryEmail: 'docs@example.com' });

    const cases: Array<[string[] | undefined, boolean]> = [
      [undefined, false],
      [[], false],
      [[`${owner}:write`], false],
      [[`${otherOwner}:read`, `${otherOwner}:*`], false],
      [[required], true],
      [[`${owner}:*`], true],
      [['*'], true]
    ];
    for (const [scopes, allowed] of cases) {
      protectedWork.mockClear();
      const key = await createApiKey(config, {
        userId,
        name: 'docs-example',
        scopes,
        // Caller-supplied metadata is never a grant.
        metadata: { scopes: [required, '*'] }
      });
      const response = await router.handle(new Request('https://example.com/auth/doc-example', {
        headers: { authorization: `Bearer ${key.secret}` }
      }));
      expect({ scopes, status: response.status }).toEqual({ scopes, status: allowed ? 200 : 403 });
      expect(protectedWork).toHaveBeenCalledTimes(allowed ? 1 : 0);
      if (!allowed) expect(await response.json()).toEqual({ error: 'forbidden' });
    }

    protectedWork.mockClear();
    const unauthenticated = await router.handle(new Request('https://example.com/auth/doc-example'));
    expect(unauthenticated.status).toBe(401);
    expect(protectedWork).not.toHaveBeenCalled();
  });

  it('returns 403 when session scopes are malformed even if metadata and attributes claim a grant', async () => {
    const config = createConfig();
    const auth = createTestServer(config);
    const protectedWork = vi.fn(() => Response.json({ allowed: true }));
    const required = requiredScope(guide);
    for (const scopes of [undefined, null, required, {}, [7]]) {
      const authenticate = vi.spyOn(auth.provider, 'authenticate').mockResolvedValue({
        id: 'key', type: 'api-key', actorType: 'api-key', actorId: 'key', resourceIds: [], methods: ['api-key'],
        scopes: scopes as unknown as string[],
        subject: { actorType: 'api-key', actorId: 'key', attributes: { scopes: [required] } },
        metadata: { scopes: [required] }
      });
      try {
        const handler = documentedHandler(guide, auth, protectedWork);
        const router = createAuthFnRouter(config, {}, [{ method: 'GET', path: '/doc-example', handler }]);
        const response = await router.handle(new Request('https://example.com/auth/doc-example'));
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({ error: 'forbidden' });
        expect(protectedWork).not.toHaveBeenCalled();
      } finally {
        authenticate.mockRestore();
      }
    }
  });

  it('lets an interactive bearer session through and denies one whose scopes were narrowed', async () => {
    const config = createConfig();
    const auth = createTestServer(config);
    const protectedWork = vi.fn(() => Response.json({ allowed: true }));
    const handler = documentedHandler(guide, auth, protectedWork);
    const router = createAuthFnRouter(config, {}, [{ method: 'GET', path: '/doc-example', handler }]);
    const user = await createUser(config, { primaryEmail: 'docs@example.com' });
    const issued = await issueSession(config, {}, { userId: user.id, methods: ['password'] });
    expect(issued.session.scopes).toEqual(['*']);

    const response = await router.handle(new Request('https://example.com/auth/doc-example', {
      headers: { authorization: `Bearer ${issued.sessionToken}` }
    }));
    expect(response.status).toBe(200);
    expect(protectedWork).toHaveBeenCalledTimes(1);

    protectedWork.mockClear();
    const narrowed: AuthFnSession = { ...issued.session, scopes: [], metadata: { scopes: ['*'] } };
    const authenticate = vi.spyOn(auth.provider, 'authenticate').mockResolvedValue(narrowed);
    try {
      const denied = await router.handle(new Request('https://example.com/auth/doc-example'));
      expect(denied.status).toBe(403);
      expect(protectedWork).not.toHaveBeenCalled();
    } finally {
      authenticate.mockRestore();
    }
  });

  it('keeps executable scope examples synchronized in the generated reference', () => {
    const generated = readFileSync(new URL('../../../docs/static/llms-full.txt', import.meta.url), 'utf8');
    expect(generated).toContain(scopeExample(guide));
  });

  // A whole-program typecheck: the file's first one loads the TypeScript libraries cold and takes up to 4.7s on CI.
  it.each([false, true])('typechecks the current public source with core build artifacts hidden: %s', { timeout: 30_000 }, (hideBuildArtifacts) => {
    const fileName = fileURLToPath(new URL(`../../__docs_scope_${guide}.ts`, import.meta.url)).replaceAll('\\', '/');
    const publicEntry = fileURLToPath(new URL('../index.ts', import.meta.url)).replaceAll('\\', '/');
    const buildDirectory = fileURLToPath(new URL('../../dist/', import.meta.url)).replaceAll('\\', '/');
    const source = `
      declare const auth: import('authfn').AuthFnServer;
      declare const handleAuthorizedRequest: (request: Request, session: import('authfn').AuthFnSession) => Response | Promise<Response>;
      declare const app: {
        get(path: string, handler: (context: { req: { raw: Request }; json(data: unknown, status?: number): Response }) => Promise<Response>): void;
      };
      ${scopeExample(guide)}
    `;
    const options: ts.CompilerOptions = {
      noEmit: true, strict: true, skipLibCheck: true, types: ['node'],
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      // Match Vitest's public-entry alias without depending on an earlier self-build.
      paths: { authfn: [publicEntry] }
    };
    const host = ts.createCompilerHost(options);
    const fileExists = host.fileExists.bind(host);
    host.fileExists = (name) => !(hideBuildArtifacts && name.startsWith(buildDirectory)) && fileExists(name);
    const getSourceFile = host.getSourceFile.bind(host);
    host.getSourceFile = (name, ...args) => name === fileName
      ? ts.createSourceFile(name, source, options.target!, true)
      : hideBuildArtifacts && name.startsWith(buildDirectory)
        ? undefined
        : getSourceFile(name, ...args);
    const program = ts.createProgram([fileName], options, host);
    const diagnostics = ts.getPreEmitDiagnostics(program);
    expect(diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))).toEqual([]);
    expect(program.getSourceFile(publicEntry)).toBeDefined();
    expect(program.getSourceFiles().some((file) => file.fileName.startsWith(buildDirectory))).toBe(false);
  });
});
