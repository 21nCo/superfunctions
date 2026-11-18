import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// Type-checks a consumer file against the public `authfn` entry with the
// TypeScript compiler API, the way `scopes.test.ts` checks `requireScopes`.
function typeCheck(source: string): { diagnostics: string[]; loadedPublicEntry: boolean } {
  const fileName = fileURLToPath(new URL('../../__session_typing.ts', import.meta.url)).replaceAll('\\', '/');
  const publicEntry = fileURLToPath(new URL('../index.ts', import.meta.url)).replaceAll('\\', '/');
  const options: ts.CompilerOptions = {
    noEmit: true, strict: true, skipLibCheck: true, types: ['node'],
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    paths: { authfn: [publicEntry] }
  };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, ...args) => name === fileName
    ? ts.createSourceFile(name, source, options.target!, true)
    : getSourceFile(name, ...args);
  const program = ts.createProgram([fileName], options, host);
  return {
    diagnostics: ts.getPreEmitDiagnostics(program)
      .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')),
    loadedPublicEntry: program.getSourceFile(publicEntry) !== undefined
  };
}

describe('AuthFnSession typing', () => {
  // A whole-program typecheck: loading the TypeScript libraries cold takes several seconds on CI.
  it('narrows credential on type and requires it on API-key sessions', { timeout: 30_000 }, () => {
    const result = typeCheck(`
      import type {
        AuthFnApiKeySession,
        AuthFnServer,
        AuthFnSession,
        AuthFnSessionCredential,
        AuthFnUserSession
      } from 'authfn';
      type IsExactly<T, U> = [T] extends [U] ? ([U] extends [T] ? true : false) : false;
      declare const session: AuthFnSession;

      if (session.type === 'api-key') {
        const credential: AuthFnSessionCredential = session.credential;
        const id: string = session.credential.id;
        const idIsString: IsExactly<typeof session.credential.id, string> = true;
        const apiKeySession: AuthFnApiKeySession = session;
        void [credential, id, idIsString, apiKeySession];
      }

      if (session.type === 'session') {
        const credentialIsUndefined: IsExactly<typeof session.credential, undefined> = true;
        const userSession: AuthFnUserSession = session;
        // @ts-expect-error an interactive session never carries a credential
        session.credential.id;
        void [credentialIsUndefined, userSession];
      }

      // Indexed access on the union keeps working.
      const methods: AuthFnSession['methods'] = ['api-key'];
      const scopes: AuthFnSession['scopes'] = ['*'];
      const optionalCredential: AuthFnSession['credential'] = undefined;
      void [methods, scopes, optionalCredential];

      const base = {
        id: 'key_typing', subject: { actorId: 'key_typing', actorType: 'api-key' as const },
        actorId: 'key_typing', actorType: 'api-key' as const, methods: ['api-key' as const], scopes: []
      };
      const withCredential: AuthFnSession = { ...base, type: 'api-key', credential: { type: 'api-key', id: 'key_typing' } };
      // @ts-expect-error an API-key session without a credential does not compile
      const withoutCredential: AuthFnSession = { ...base, type: 'api-key' };
      // @ts-expect-error an interactive session cannot carry a credential
      const userWithCredential: AuthFnSession = { ...base, type: 'session', credential: { type: 'api-key', id: 'key_typing' } };
      void [withCredential, withoutCredential, userWithCredential];

      // A plugin or host authenticator that returns an API-key session must set the credential.
      const authenticate: AuthFnServer['provider']['authenticate'] = async () =>
        // @ts-expect-error the returned API-key session is missing its credential
        ({ ...base, type: 'api-key' });
      void authenticate;
    `);
    expect(result.diagnostics).toEqual([]);
    expect(result.loadedPublicEntry).toBe(true);
  });
});
