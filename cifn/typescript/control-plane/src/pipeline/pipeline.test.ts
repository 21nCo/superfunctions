import { describe, it, expect } from 'vitest';
import { parse, normalizeParsedPipeline } from './parser.js';
import { validate } from './validator.js';
import type { PipelineSpec, ValidationResult } from './types.js';

const minimalYaml = `
name: min
on:
  workflow_dispatch: {}
jobs:
  build:
    runs-on: default
    steps:
      - run: echo ok
`;

const minimalJson = JSON.stringify({
  name: 'min',
  on: { workflow_dispatch: {} },
  jobs: { build: { 'runs-on': 'default', steps: [{ run: 'echo ok' }] } },
});

describe('Parser', () => {
  // TV-PIPE-001: Valid YAML pipeline accepted
  it('TV-PIPE-001: parses valid YAML pipeline', () => {
    const result = parse(minimalYaml, 'yaml');
    expect(result).toBeDefined();
    expect((result as any).name).toBe('min');
    expect((result as any).jobs.build.steps[0].run).toBe('echo ok');
  });

  // TV-PIPE-002: Valid JSON pipeline accepted
  it('TV-PIPE-002: parses valid JSON pipeline', () => {
    const result = parse(minimalJson, 'json');
    expect(result).toBeDefined();
    expect((result as any).name).toBe('min');
    expect((result as any).jobs.build.steps[0].run).toBe('echo ok');
  });

  it('auto-detects JSON', () => {
    const result = parse(minimalJson);
    expect((result as any).name).toBe('min');
  });

  it('auto-detects YAML', () => {
    const result = parse(minimalYaml);
    expect((result as any).name).toBe('min');
  });

  it('throws on invalid JSON', () => {
    expect(() => parse('{ bad json', 'json')).toThrow('Failed to parse JSON');
  });

  it('throws on invalid YAML', () => {
    expect(() => parse(':\n  :\n    - :', 'yaml')).toThrow('Failed to parse YAML');
  });

  // TV-LIMIT-001: Pipeline document too large
  it('TV-LIMIT-001: rejects document exceeding 500KB', () => {
    const large = 'a'.repeat(500 * 1024 + 1);
    expect(() => parse(large)).toThrow('exceeds maximum size of 500KB');
  });

  it('accepts document exactly 500KB', () => {
    const yamlContent = `name: x\non:\n  workflow_dispatch: {}\njobs:\n  build:\n    runs-on: default\n    steps:\n      - run: echo ok\n`;
    const padded = yamlContent + '#' + ' '.repeat(500 * 1024 - yamlContent.length - 1);
    expect(() => parse(padded, 'yaml')).not.toThrow();
  });
});

describe('Validator', () => {
  function parseAndValidate(input: string, format?: 'yaml' | 'json'): ValidationResult {
    const parsed = parse(input, format);
    return validate(normalizeParsedPipeline(parsed));
  }

  // TV-PIPE-001 + TV-PIPE-003: Valid YAML pipeline passes validation
  it('TV-PIPE-001/003: valid YAML pipeline passes validation', () => {
    const result = parseAndValidate(minimalYaml, 'yaml');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spec.jobs.build).toBeDefined();
      expect(result.spec.jobs.build.steps[0]).toHaveProperty('run', 'echo ok');
      expect(result.spec.jobs.build['runs-on']).toBe('default');
    }
  });

  // TV-PIPE-002: Valid JSON pipeline passes validation
  it('TV-PIPE-002: valid JSON pipeline passes validation', () => {
    const result = parseAndValidate(minimalJson, 'json');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spec.jobs.build).toBeDefined();
    }
  });

  // TV-PIPE-004: Invalid config fails validation (unknown uses)
  it('TV-PIPE-004: rejects unknown uses in step', () => {
    const input = JSON.stringify({
      name: 'x',
      on: { workflow_dispatch: {} },
      jobs: {
        build: {
          'runs-on': 'default',
          steps: [{ uses: 'unknown/action' }],
        },
      },
    });
    const result = parseAndValidate(input, 'json');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('PIPELINE_INVALID');
    }
  });

  // TV-PIPE-005: All supported step types accepted
  it('TV-PIPE-005: accepts all supported step types', () => {
    const input = JSON.stringify({
      name: 'all-steps',
      on: { workflow_dispatch: {} },
      jobs: {
        checkout_job: {
          'runs-on': 'default',
          steps: [{ uses: 'checkout' }],
        },
        cache_job: {
          'runs-on': 'default',
          steps: [
            { uses: 'cache/restore', with: { path: 'node_modules', key: 'deps-1' } },
            { uses: 'cache/save', with: { path: 'node_modules', key: 'deps-1' } },
          ],
        },
        artifact_job: {
          'runs-on': 'default',
          steps: [
            { uses: 'artifact/upload', with: { name: 'out', path: 'dist/' } },
            { uses: 'artifact/download', with: { name: 'out' } },
          ],
        },
        test_job: {
          'runs-on': 'default',
          steps: [{ uses: 'testfn/run', with: { framework: 'vitest' } }],
        },
        deploy_job: {
          'runs-on': 'hostfn-runner',
          steps: [{ uses: 'hostfn/deploy', with: { environment: 'prod', ci: true } }],
        },
        shell_job: {
          'runs-on': 'default',
          steps: [{ run: 'echo hello' }],
        },
      },
    });
    const result = parseAndValidate(input, 'json');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.keys(result.spec.jobs)).toHaveLength(6);
    }
  });

  // TV-PIPE-006: Unknown uses rejected
  it('TV-PIPE-006: rejects notreal/action', () => {
    const input = JSON.stringify({
      on: { workflow_dispatch: {} },
      jobs: {
        build: {
          'runs-on': 'default',
          steps: [{ uses: 'notreal/action' }],
        },
      },
    });
    const result = parseAndValidate(input, 'json');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('PIPELINE_INVALID');
    }
  });

  // TV-EXPR-006: Unsupported expression syntax rejected
  it('TV-EXPR-006: rejects unsupported operator in if', () => {
    const input = JSON.stringify({
      name: 'bad-expr',
      on: { workflow_dispatch: {} },
      jobs: {
        build: {
          'runs-on': 'default',
          steps: [{ run: 'echo ok', if: "github.ref =~ 'main'" }],
        },
      },
    });
    const result = parseAndValidate(input, 'json');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('PIPELINE_INVALID');
      expect(result.message).toMatch(/if|Unsupported|expression/i);
    }
  });

  // TV-EXPR-008: Expression length cap enforced
  it('TV-EXPR-008: rejects if expression exceeding 2048 chars', () => {
    const longIf = 'a'.repeat(2049);
    const input = JSON.stringify({
      name: 'long-expr',
      on: { workflow_dispatch: {} },
      jobs: {
        build: {
          'runs-on': 'default',
          steps: [{ run: 'echo ok', if: longIf }],
        },
      },
    });
    const result = parseAndValidate(input, 'json');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('PIPELINE_INVALID');
      expect(result.message).toMatch(/2048|length|expression/i);
    }
  });

  // TV-PIPE-007: All trigger types parse
  it('TV-PIPE-007: accepts all trigger types', () => {
    const input = JSON.stringify({
      name: 'triggers',
      on: {
        push: { branches: ['main'] },
        pull_request: { branches: ['main'] },
        schedule: { cron: '0 0 * * *' },
        workflow_dispatch: {},
      },
      jobs: {
        build: {
          'runs-on': 'default',
          steps: [{ run: 'echo ok' }],
        },
      },
    });
    const result = parseAndValidate(input, 'json');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spec.on.push).toBeDefined();
      expect(result.spec.on.pull_request).toBeDefined();
      expect(result.spec.on.schedule).toBeDefined();
      expect(Array.isArray(result.spec.on.schedule)).toBe(true);
      if (result.spec.on.schedule) expect(result.spec.on.schedule.length).toBe(1);
      expect(result.spec.on.workflow_dispatch).toBeDefined();
    }
  });

  // TV-PIPE-010: schedule array accepted, canonical spec has array
  it('TV-PIPE-010: schedule array accepted and stored as array', () => {
    const input = `
name: sched-array
on:
  schedule:
    - cron: "0 2 * * *"
jobs:
  build: { runs-on: default, steps: [ { run: "echo ok" } ] }
`;
    const result = parseAndValidate(input, 'yaml');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Array.isArray(result.spec.on.schedule)).toBe(true);
      expect(result.spec.on.schedule?.length).toBe(1);
      expect(result.spec.on.schedule?.[0]?.cron).toBe('0 2 * * *');
    }
  });

  // TV-PIPE-011: schedule object accepted and normalized to array
  it('TV-PIPE-011: schedule object accepted and normalized to single-element array', () => {
    const input = `
name: sched-obj
on:
  schedule:
    cron: "0 2 * * *"
jobs:
  build: { runs-on: default, steps: [ { run: "echo ok" } ] }
`;
    const result = parseAndValidate(input, 'yaml');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Array.isArray(result.spec.on.schedule)).toBe(true);
      expect(result.spec.on.schedule?.length).toBe(1);
      expect(result.spec.on.schedule?.[0]?.cron).toBe('0 2 * * *');
    }
  });

  // TV-PIPE-012: invalid cron rejected
  it('TV-PIPE-012: invalid cron rejected with PIPELINE_INVALID', () => {
    const input = JSON.stringify({
      name: 'bad-cron',
      on: { schedule: [{ cron: 'not-a-cron' }] },
      jobs: { build: { 'runs-on': 'default', steps: [{ run: 'echo ok' }] } },
    });
    const result = parseAndValidate(input, 'json');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('PIPELINE_INVALID');
      expect(result.message).toContain('cron');
    }
  });

  // TV-PIPE-014: unknown with key rejected for known action
  it('TV-PIPE-014: rejects unknown with key for artifact/upload', () => {
    const input = `
name: bad-with
on: { workflow_dispatch: {} }
jobs:
  build:
    runs-on: default
    steps:
      - uses: artifact/upload
        with:
          name: dist
          path: dist/
          unexpected: true
`;
    const result = parseAndValidate(input, 'yaml');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('PIPELINE_INVALID');
  });

  // TV-PIPE-015: missing required with fields rejected
  it('TV-PIPE-015: rejects artifact/upload missing path', () => {
    const input = `
name: bad-with2
on: { workflow_dispatch: {} }
jobs:
  build:
    runs-on: default
    steps:
      - uses: artifact/upload
        with:
          name: dist
`;
    const result = parseAndValidate(input, 'yaml');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('PIPELINE_INVALID');
      expect(result.message).toMatch(/path|required|schema/i);
    }
  });

  // TV-RUN-002: Job order respects needs
  it('TV-RUN-002: accepts pipeline with valid needs', () => {
    const input = JSON.stringify({
      on: { workflow_dispatch: {} },
      jobs: {
        build: { 'runs-on': 'default', steps: [{ run: 'echo build' }] },
        test: { 'runs-on': 'default', needs: ['build'], steps: [{ run: 'echo test' }] },
      },
    });
    const result = parseAndValidate(input, 'json');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spec.jobs.test.needs).toEqual(['build']);
    }
  });

  // TV-RUN-003: Cyclic needs rejected
  it('TV-RUN-003: rejects cyclic needs', () => {
    const input = JSON.stringify({
      on: { workflow_dispatch: {} },
      jobs: {
        a: { 'runs-on': 'default', needs: ['b'], steps: [{ run: 'echo a' }] },
        b: { 'runs-on': 'default', needs: ['a'], steps: [{ run: 'echo b' }] },
      },
    });
    const result = parseAndValidate(input, 'json');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('PIPELINE_INVALID');
      expect(result.message).toContain('Cyclic');
    }
  });

  it('rejects needs referencing non-existent job', () => {
    const input = JSON.stringify({
      on: { workflow_dispatch: {} },
      jobs: {
        build: { 'runs-on': 'default', needs: ['nonexistent'], steps: [{ run: 'echo' }] },
      },
    });
    const result = parseAndValidate(input, 'json');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('PIPELINE_INVALID');
      expect(result.message).toContain('unknown dependency');
    }
  });

  // TV-LIMIT-002: Jobs or steps over limit
  it('TV-LIMIT-002: rejects pipeline with 101 jobs', () => {
    const jobs: Record<string, any> = {};
    for (let i = 0; i < 101; i++) {
      jobs[`job${i}`] = { 'runs-on': 'default', steps: [{ run: 'echo' }] };
    }
    const input = JSON.stringify({ on: { workflow_dispatch: {} }, jobs });
    const result = parseAndValidate(input, 'json');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('PIPELINE_INVALID');
      expect(result.message).toContain('Too many jobs');
    }
  });

  it('accepts pipeline with exactly 100 jobs', () => {
    const jobs: Record<string, any> = {};
    for (let i = 0; i < 100; i++) {
      jobs[`job${i}`] = { 'runs-on': 'default', steps: [{ run: 'echo' }] };
    }
    const input = JSON.stringify({ on: { workflow_dispatch: {} }, jobs });
    const result = parseAndValidate(input, 'json');
    expect(result.ok).toBe(true);
  });

  it('TV-LIMIT-002: rejects job with 101 steps', () => {
    const steps = Array.from({ length: 101 }, () => ({ run: 'echo' }));
    const input = JSON.stringify({
      on: { workflow_dispatch: {} },
      jobs: { build: { 'runs-on': 'default', steps } },
    });
    const result = parseAndValidate(input, 'json');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('PIPELINE_INVALID');
      expect(result.message).toContain('steps');
    }
  });

  it('accepts job with exactly 100 steps', () => {
    const steps = Array.from({ length: 100 }, () => ({ run: 'echo' }));
    const input = JSON.stringify({
      on: { workflow_dispatch: {} },
      jobs: { build: { 'runs-on': 'default', steps } },
    });
    const result = parseAndValidate(input, 'json');
    expect(result.ok).toBe(true);
  });

  it('TV-LIMIT-002: rejects needs depth > 10', () => {
    const jobs: Record<string, any> = {};
    for (let i = 0; i <= 11; i++) {
      const needs = i > 0 ? [`job${i - 1}`] : [];
      jobs[`job${i}`] = { 'runs-on': 'default', needs, steps: [{ run: 'echo' }] };
    }
    const input = JSON.stringify({ on: { workflow_dispatch: {} }, jobs });
    const result = parseAndValidate(input, 'json');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('PIPELINE_INVALID');
      expect(result.message).toContain('needs depth');
    }
  });

  it('accepts needs depth exactly 10', () => {
    const jobs: Record<string, any> = {};
    for (let i = 0; i <= 10; i++) {
      const needs = i > 0 ? [`job${i - 1}`] : [];
      jobs[`job${i}`] = { 'runs-on': 'default', needs, steps: [{ run: 'echo' }] };
    }
    const input = JSON.stringify({ on: { workflow_dispatch: {} }, jobs });
    const result = parseAndValidate(input, 'json');
    expect(result.ok).toBe(true);
  });

  // TV-LIMIT-003: artifact name length cap enforced
  it('TV-LIMIT-003: rejects artifact name length > 256', () => {
    const longName = 'a'.repeat(257);
    const input = JSON.stringify({
      on: { workflow_dispatch: {} },
      jobs: {
        build: {
          'runs-on': 'default',
          steps: [{ uses: 'artifact/upload', with: { name: longName, path: 'dist/' } }],
        },
      },
    });
    const result = parseAndValidate(input, 'json');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('PIPELINE_INVALID');
  });

  // TV-LIMIT-003: cache key length cap enforced
  it('TV-LIMIT-003: rejects cache key length > 1024', () => {
    const longKey = 'k'.repeat(1025);
    const input = JSON.stringify({
      on: { workflow_dispatch: {} },
      jobs: {
        build: {
          'runs-on': 'default',
          steps: [{ uses: 'cache/restore', with: { key: longKey, path: 'node_modules' } }],
        },
      },
    });
    const result = parseAndValidate(input, 'json');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('PIPELINE_INVALID');
  });

  it('rejects pipeline with no jobs', () => {
    const input = JSON.stringify({ on: { workflow_dispatch: {} }, jobs: {} });
    const result = parseAndValidate(input, 'json');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('PIPELINE_INVALID');
    }
  });

  it('rejects pipeline with no triggers', () => {
    const input = JSON.stringify({
      on: {},
      jobs: { build: { 'runs-on': 'default', steps: [{ run: 'echo' }] } },
    });
    const result = parseAndValidate(input, 'json');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('PIPELINE_INVALID');
    }
  });

  it('rejects step with both run and uses', () => {
    const input = JSON.stringify({
      on: { workflow_dispatch: {} },
      jobs: {
        build: {
          'runs-on': 'default',
          steps: [{ run: 'echo', uses: 'checkout' }],
        },
      },
    });
    const result = parseAndValidate(input, 'json');
    expect(result.ok).toBe(false);
  });

  it('accepts step with if condition', () => {
    const input = JSON.stringify({
      on: { workflow_dispatch: {} },
      jobs: {
        build: {
          'runs-on': 'default',
          steps: [
            { run: 'echo build', if: "github.ref == 'refs/heads/main'" },
          ],
        },
      },
    });
    const result = parseAndValidate(input, 'json');
    expect(result.ok).toBe(true);
  });

  it('accepts job with env', () => {
    const input = JSON.stringify({
      on: { workflow_dispatch: {} },
      jobs: {
        build: {
          'runs-on': 'default',
          env: { NODE_ENV: 'production' },
          steps: [{ run: 'echo build' }],
        },
      },
    });
    const result = parseAndValidate(input, 'json');
    expect(result.ok).toBe(true);
  });

  it('accepts pipeline with global env', () => {
    const input = JSON.stringify({
      on: { workflow_dispatch: {} },
      env: { CI: 'true' },
      jobs: {
        build: { 'runs-on': 'default', steps: [{ run: 'echo' }] },
      },
    });
    const result = parseAndValidate(input, 'json');
    expect(result.ok).toBe(true);
  });

  it('rejects pipeline with additional properties', () => {
    const input = JSON.stringify({
      on: { workflow_dispatch: {} },
      jobs: { build: { 'runs-on': 'default', steps: [{ run: 'echo' }] } },
      unknown_key: true,
    });
    const result = parseAndValidate(input, 'json');
    expect(result.ok).toBe(false);
  });

  it('accepts complex 3-job DAG', () => {
    const input = JSON.stringify({
      name: 'ci',
      on: { push: { branches: ['main'] } },
      jobs: {
        build: { 'runs-on': 'default', steps: [{ run: 'npm run build' }] },
        test: { 'runs-on': 'default', needs: ['build'], steps: [{ run: 'npm test' }] },
        deploy: {
          'runs-on': 'hostfn-runner',
          needs: ['test'],
          steps: [{ uses: 'hostfn/deploy', with: { environment: 'prod', ci: true } }],
        },
      },
    });
    const result = parseAndValidate(input, 'json');
    expect(result.ok).toBe(true);
  });
});
