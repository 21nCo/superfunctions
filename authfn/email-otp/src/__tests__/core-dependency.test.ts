import { describe, expect, it } from 'vitest';
// Resolved the way the published plugin resolves it: no source aliases, so
// this is the built `authfn` that `@authfn/email-otp` depends on.
import { authfn, type AuthFnDeliveryRequest, type AuthFnSession } from 'authfn';
import { createUser } from 'authfn/core/users';
import { memoryAdapter } from '../../../../packages/db/src/testing/index.js';
import { describeAuthfnDependency } from '../../../test-support/workspace-core.js';
import { authFnEmailOtpPlugin } from '../index.js';

describeAuthfnDependency({ describe, it, expect }, new URL('../../', import.meta.url));

describe('authfn core behaviour', () => {
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
