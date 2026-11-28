import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  CredentialMinterError,
  defineScopeGrammar,
  ScopeNotGrantable,
  type CredentialMinter,
  type MintedCredential,
} from 'plugfn';

const grammar = defineScopeGrammar({
  provider: 'example',
  dimensions: { names: { kind: 'exactSet' } },
  riskOf: () => 'read',
});

describe('CredentialMinter interface', () => {
  it('fits a callback grammar and a provider-specific handle', async () => {
    const minter: CredentialMinter<string, { names?: readonly string[] }, { id: string }, typeof grammar> = {
      provider: 'example',
      grammar,
      async mint({ ttl }) {
        return { secret: 'test-secret', expiresAt: new Date(ttl * 1000), revokeHandle: { id: 'test-handle' } };
      },
      async revoke() {},
    };
    expectTypeOf(minter.mint).returns.resolves.toEqualTypeOf<MintedCredential<{ id: string }>>();
    const minted = await minter.mint({ installation: 'test-installation', scope: { names: ['a'] }, ttl: 60 });
    expect(minted.expiresAt.getTime()).toBe(60_000);
    expect(minter.grammar.classifyRisk({ names: ['a'] })).toBe('read');
  });
});

describe('credential minter errors', () => {
  it('carry provider, code, status and retryability', () => {
    const cause = new Error('test-cause');
    const error = new CredentialMinterError('example', 'provider_unavailable', 'down', { status: 503, retryable: true, cause });
    expect(error).toBeInstanceOf(Error);
    expect([error.name, error.provider, error.code, error.status, error.retryable, error.cause]).toEqual([
      'CredentialMinterError',
      'example',
      'provider_unavailable',
      503,
      true,
      cause,
    ]);
    const plain = new CredentialMinterError('example', 'unauthorized', 'no');
    expect([plain.status, plain.retryable, Object.hasOwn(plain, 'cause')]).toEqual([undefined, false, false]);
  });

  it('ScopeNotGrantable is a non-retryable CredentialMinterError with frozen violations', () => {
    const violations = grammar.normalize({ names: 'x' } as never).violations;
    const error = new ScopeNotGrantable('example', 'not grantable', { status: 422, retryable: true, violations });
    expect(error).toBeInstanceOf(CredentialMinterError);
    expect([error.name, error.code, error.status, error.retryable]).toEqual(['ScopeNotGrantable', 'scope_not_grantable', 422, false]);
    expect(error.violations).toEqual(violations);
    expect(error.violations).not.toBe(violations);
    expect(Object.isFrozen(error.violations)).toBe(true);
    expect(new ScopeNotGrantable('example', 'none').violations).toEqual([]);
  });
});
