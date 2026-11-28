import { describe, expect, it } from 'vitest';
import { ScopeError } from 'plugfn/scopes';
import { githubAppScopeGrammar, toAccessTokenRequest, type GitHubAppScope } from '../../src/github-app/index.js';

const envelope: GitHubAppScope = {
  repositories: ['App', 'lib'],
  permissions: { contents: 'write', issues: 'read', metadata: 'read' },
};

function violations(request: GitHubAppScope) {
  return githubAppScopeGrammar.isSubset(request, envelope).violations.map((v) => [v.code, v.dimension, v.item]);
}

describe('GitHub App scope grammar', () => {
  it('accepts requests inside the envelope, a lower permission level included', () => {
    const decision = githubAppScopeGrammar.isSubset({ repositories: ['app'], permissions: { contents: 'read', metadata: 'read' } }, envelope);
    expect(decision.ok).toBe(true);
    expect(decision.scope && toAccessTokenRequest(decision.scope)).toEqual({
      repositories: ['app'],
      permissions: { contents: 'read', metadata: 'read' },
    });
    expect(githubAppScopeGrammar.isSubset({ repositories: ['lib', 'APP'], permissions: { contents: 'write' } }, envelope).ok).toBe(true);
    expect(githubAppScopeGrammar.isSubset({}, envelope).ok).toBe(true);
  });

  it('rejects a repository, permission or level outside the envelope', () => {
    expect(violations({ repositories: ['other'] })).toEqual([['not_in_envelope', 'repositories', 'other']]);
    expect(violations({ permissions: { issues: 'write' } })).toEqual([['not_in_envelope', 'permissions', 'issues:write']]);
    expect(violations({ permissions: { contents: 'admin' } })).toEqual([['not_in_envelope', 'permissions', 'contents:admin']]);
    expect(violations({ permissions: { administration: 'read' } })).toEqual([['not_in_envelope', 'permissions', 'administration:read']]);
  });

  it('treats malformed requests and envelopes as malformed, never as wider', () => {
    const bad: unknown[] = [
      { repositories: ['example-org/app'] },
      { repositories: ['..'] },
      { repositories: ['a'.repeat(101)] },
      { permissions: { contents: 'none' } },
      { permissions: { Contents: 'read' } },
      { permissions: ['contents:read'] },
      { repositories: ['app'], extra: true },
      'contents:read',
    ];
    for (const request of bad) {
      const decision = githubAppScopeGrammar.isSubset(request as GitHubAppScope, envelope);
      expect(decision.ok).toBe(false);
      expect(decision.violations[0]!.code).toBe('malformed');
      expect(githubAppScopeGrammar.isSubset({}, request as GitHubAppScope).ok).toBe(false);
    }
  });

  it('classifies admin levels and administration permissions as destructive', () => {
    expect(githubAppScopeGrammar.classifyRisk({ repositories: ['app'] })).toBe('read');
    expect(githubAppScopeGrammar.classifyRisk({ repositories: ['app'], permissions: { contents: 'read' } })).toBe('read');
    expect(githubAppScopeGrammar.classifyRisk({ permissions: { contents: 'read', issues: 'write' } })).toBe('write');
    expect(githubAppScopeGrammar.classifyRisk({ permissions: { organization_projects: 'admin' } })).toBe('destructive');
    expect(githubAppScopeGrammar.classifyRisk({ permissions: { administration: 'read' } })).toBe('destructive');
    expect(githubAppScopeGrammar.classifyRisk({ permissions: { administration: 'write' } })).toBe('destructive');
    const decision = githubAppScopeGrammar.isSubset({ permissions: { contents: 'write' } }, envelope);
    expect(decision.ok && githubAppScopeGrammar.classifyScope(decision.scope)).toBe('write');
    expect(() => githubAppScopeGrammar.classifyRisk({ permissions: { contents: 'owner' } } as never)).toThrow(ScopeError);
  });

  it('builds the access_tokens body from the highest level of each permission', () => {
    const normalized = githubAppScopeGrammar.normalize({ repositories: ['Lib', 'app'], permissions: { issues: 'admin', contents: 'read' } });
    expect(normalized.ok).toBe(true);
    expect(normalized.scope!.permissions).toEqual(['issues:read', 'issues:write', 'issues:admin', 'contents:read']);
    expect(toAccessTokenRequest(normalized.scope!)).toEqual({ repositories: ['app', 'lib'], permissions: { contents: 'read', issues: 'admin' } });
  });
});
