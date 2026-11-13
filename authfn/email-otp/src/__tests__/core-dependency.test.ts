import { createRequire } from 'node:module';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// Resolved the way the published plugin resolves it: no source aliases, so
// this is the built `authfn` that `@authfn/email-otp` depends on.
import { authfn, type AuthFnDeliveryRequest, type AuthFnSession } from 'authfn';
import { createUser } from 'authfn/core/users';
import { memoryAdapter } from '../../../../packages/db/src/testing/index.js';
import { authFnEmailOtpPlugin } from '../index.js';

describe('authfn dependency', () => {
  const workspaceInstalled = existsSync(new URL('../../../../node_modules/authfn', import.meta.url));

  it.runIf(workspaceInstalled)('resolves the workspace authfn core', () => {
    const resolved = createRequire(import.meta.url).resolve('authfn');
    const workspaceCore = fileURLToPath(new URL('../../../core/dist/index.js', import.meta.url));
    expect(realpathSync(resolved)).toBe(realpathSync(workspaceCore));
  });

  // The release build installs only this package, so it tests against the
  // published authfn that the release pins.
  it.skipIf(workspaceInstalled)('resolves the pinned authfn release', () => {
    type Manifest = { version: string; dependencies: Record<string, string> };
    const manifest = (url: URL): Manifest => JSON.parse(readFileSync(url, 'utf8')) as Manifest;
    const pinned = manifest(new URL('../../package.json', import.meta.url)).dependencies.authfn;
    const installed = manifest(new URL('../../node_modules/authfn/package.json', import.meta.url)).version;
    expect(installed).toBe(pinned);
  });

  // authfn 0.6.0 gives every interactive user session the `*` scope. A plugin
  // that resolves an older core issues sessions without `scopes`.
  it('issues an email OTP sign-in session that holds every scope', async () => {
    const codes = new Map<string, string>();
    const issued: AuthFnSession[] = [];
    const database = memoryAdapter({ debug: false });
    const pluginRuntime = {
      emailOtp: {
        delivery: {
          async send(input: AuthFnDeliveryRequest) {
            codes.set(`${input.purpose}:${input.email}`, input.code);
            return { sent: true };
          }
        }
      }
    };
    const authApp = authfn({ plugins: [authFnEmailOtpPlugin()] });
    const auth = authApp.createServer({
      database,
      pluginRuntime,
      hooks: {
        afterSessionIssue: (_ctx, session) => {
          issued.push(session);
        }
      }
    });
    await createUser({ database, namespace: 'authfn', plugins: [authFnEmailOtpPlugin()] }, {
      primaryEmail: 'ada@example.com'
    });

    const post = (path: string, body: Record<string, unknown>) =>
      auth.router.handle(
        new Request(`https://account.example.com/auth${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body)
        })
      );

    expect((await post('/otp/send', { purpose: 'sign-in', email: 'ada@example.com' })).status).toBe(200);
    const verify = await post('/otp/verify', {
      purpose: 'sign-in',
      email: 'ada@example.com',
      code: codes.get('sign-in:ada@example.com')
    });

    expect(verify.status).toBe(200);
    const body = (await verify.json()) as { data: { session: AuthFnSession } };
    expect(body.data.session.methods).toEqual(['email-otp']);
    expect(body.data.session.scopes).toEqual(['*']);
    expect(issued).toHaveLength(1);
    expect(issued[0]?.scopes).toEqual(['*']);
  });
});
