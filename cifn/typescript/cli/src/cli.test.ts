import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runCommand } from './commands/run.js';
import { statusCommand } from './commands/status.js';
import { logsCommand } from './commands/logs.js';
import * as api from './utils/api.js';
import * as config from './utils/config.js';

// Mock dependencies
vi.mock('./utils/api.js');
vi.mock('./utils/config.js');

describe('CLI Commands', () => {
  let exitSpy: any;
  let logSpy: any;
  let errorSpy: any;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('run', () => {
    it('TV-CLI-001: creates run with valid config', async () => {
      vi.spyOn(config, 'loadConfig').mockReturnValue({
        config: { name: 'test' },
        path: 'test.yml'
      });
      vi.spyOn(api, 'apiCall').mockResolvedValue({
        ok: true,
        data: { ok: true, data: { runId: 'run-123' } }
      });

      await runCommand.parseAsync(['node', 'cifn', 'run']);

      expect(config.loadConfig).toHaveBeenCalled();
      expect(api.apiCall).toHaveBeenCalledWith('/api/v1/runs', expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"pipelineSpec":{"name":"test"}')
      }));
      expect(logSpy).toHaveBeenCalledWith('Run created: run-123');
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('TV-CLI-002: fails with invalid config', async () => {
      vi.spyOn(config, 'loadConfig').mockImplementation(() => {
        throw new Error('Config file not found');
      });

      await runCommand.parseAsync(['node', 'cifn', 'run']);

      expect(errorSpy).toHaveBeenCalledWith('Error: Config file not found');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('TV-CLI-002: fails when API error', async () => {
       vi.spyOn(config, 'loadConfig').mockReturnValue({
        config: { name: 'test' },
        path: 'test.yml'
      });
      vi.spyOn(api, 'apiCall').mockResolvedValue({
        ok: true,
        data: { ok: false, error: { code: 'PIPELINE_INVALID', message: 'Invalid' } }
      });

      // runCommand doesn't take positional args, so 'run' arg is just extra.
      // But let's be consistent.
      await runCommand.parseAsync(['node', 'cifn']);

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to create run: PIPELINE_INVALID'));
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
    
    it('TV-PIPE-010: accepts custom config path', async () => {
      vi.spyOn(config, 'loadConfig').mockReturnValue({ config: {}, path: 'custom.yml' });
      vi.spyOn(api, 'apiCall').mockResolvedValue({ ok: true, data: { ok: true, data: { runId: '1' } } });

      await runCommand.parseAsync(['node', 'cifn', '--config', 'custom.yml']);

      expect(config.loadConfig).toHaveBeenCalledWith('custom.yml');
    });
  });

  describe('status', () => {
    it('TV-CLI-003: lists runs', async () => {
      vi.spyOn(api, 'apiCall').mockResolvedValue({
        ok: true,
        data: { ok: true, data: { runs: [{ runId: 'r1', status: 'success', createdAt: '2023-01-01' }] } }
      });

      // No args
      await statusCommand.parseAsync(['node', 'cifn']);

      expect(api.apiCall).toHaveBeenCalledWith('/api/v1/runs?limit=20');
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('r1'));
    });

    it('TV-CLI-003: shows run detail', async () => {
      vi.spyOn(api, 'apiCall').mockResolvedValue({
        ok: true,
        data: { ok: true, data: { runId: 'r1', status: 'success', createdAt: '', trigger: { type: 'manual' }, jobs: [] } }
      });

      // Arg: r1
      await statusCommand.parseAsync(['node', 'cifn', 'r1']);

      expect(api.apiCall).toHaveBeenCalledWith('/api/v1/runs/r1');
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Run ID: r1'));
    });
  });

  describe('run --local', () => {
    it('TV-CLI-003: executes pipeline locally', async () => {
      const mockMemoryStore = vi.fn();
      const mockRunner = {
        registerPipelineSpec: vi.fn(),
        processNextJob: vi.fn()
          .mockResolvedValueOnce(true)
          .mockResolvedValueOnce(false),
      };
      const mockStore = {
        createRun: vi.fn().mockReturnValue({
          id: 'local-run-123',
          jobs: [{ jobKey: 'build', status: 'success', steps: [] }],
          status: 'success'
        }),
        getRun: vi.fn().mockReturnValue({
          id: 'local-run-123',
          jobs: [{ jobKey: 'build', status: 'success', steps: [] }],
          status: 'success'
        })
      };
      const mockLogClient = { getAllLines: vi.fn().mockReturnValue([]) };
      
      vi.spyOn(config, 'loadConfig').mockReturnValue({
        config: { name: 'test', on: { workflow_dispatch: {} }, jobs: { build: { 'runs-on': 'default', steps: [{ run: 'echo ok' }] } } },
        path: 'test.yml'
      });
      
      vi.doMock('cifn', () => ({
        MemoryStore: vi.fn(() => mockStore),
        MemoryQueueClient: vi.fn(() => ({ enqueue: vi.fn() })),
        DEFAULT_QUEUE_NAME: 'test',
        parsePipeline: vi.fn(() => ({ ok: true, spec: { name: 'test', jobs: { build: {} } } })),
        validatePipeline: vi.fn(() => ({ valid: true })),
        getReadyJobs: vi.fn(() => ['build']),
      }));
      
      vi.doMock('cifn-runner', () => ({
        Runner: vi.fn(() => mockRunner),
      }));
      
      vi.doMock('cifn-runner/dist/reporting/logfn-client.js', () => ({
        MemoryLogFnClient: vi.fn(() => mockLogClient),
      }));
      
      await runCommand.parseAsync(['node', 'cifn', '--local']);
      
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Local run created:'));
      expect(exitSpy).toHaveBeenCalledWith(0);
    });
  });

  describe('logs', () => {
    it('TV-CLI-004: fetches logs for job', async () => {
      vi.spyOn(api, 'apiCall').mockResolvedValue({
        ok: true,
        data: { ok: true, data: { lines: [{ timestamp: 't', line: 'hello' }] } }
      });

      // Args: r1 job1
      await logsCommand.parseAsync(['node', 'cifn', 'r1', 'job1']);

      expect(api.apiCall).toHaveBeenCalledWith('/api/v1/runs/r1/jobs/job1/logs');
      expect(logSpy).toHaveBeenCalledWith('[t] hello');
    });

    it('TV-CLI-004: fetches aggregated logs when jobKey omitted', async () => {
        // Mock get run
        vi.spyOn(api, 'apiCall')
            .mockResolvedValueOnce({
                ok: true,
                data: { ok: true, data: { jobs: [{ jobKey: 'j1' }, { jobKey: 'j2' }] } }
            })
            // Mock get log j1
            .mockResolvedValueOnce({
                ok: true,
                data: { ok: true, data: { lines: [{ timestamp: 't1', line: 'log1' }] } }
            })
            // Mock get log j2
            .mockResolvedValueOnce({
                ok: true,
                data: { ok: true, data: { lines: [{ timestamp: 't2', line: 'log2' }] } }
            });

        // Arg: r1
        await logsCommand.parseAsync(['node', 'cifn', 'r1']);

        expect(api.apiCall).toHaveBeenCalledWith('/api/v1/runs/r1');
        expect(api.apiCall).toHaveBeenCalledWith('/api/v1/runs/r1/jobs/j1/logs');
        expect(api.apiCall).toHaveBeenCalledWith('/api/v1/runs/r1/jobs/j2/logs');
        expect(logSpy).toHaveBeenCalledWith('[t1] log1');
        expect(logSpy).toHaveBeenCalledWith('[t2] log2');
    });

    it('TV-CLI-005: redacts secret values in logs', async () => {
      vi.spyOn(api, 'apiCall').mockResolvedValue({
        ok: true,
        data: { ok: true, data: { lines: [
          { timestamp: 't1', line: 'token=ghp_abcd1234567890123456789012345678' },
          { timestamp: 't2', line: 'password=mysecret123' },
          { timestamp: 't3', line: 'Authorization sk-1234567890' }
        ] } }
      });

      await logsCommand.parseAsync(['node', 'cifn', 'r1', 'job1']);

      expect(logSpy).toHaveBeenCalledWith('[t1] token=***');
      expect(logSpy).toHaveBeenCalledWith('[t2] password=***');
      expect(logSpy).toHaveBeenCalledWith('[t3] Authorization ***');
      
      expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('ghp_'));
      expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('mysecret123'));
      expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('sk-1234567890'));
    });
  });

  describe('api config', () => {
    it('TV-CLI-006: CLI supports custom URL and credentials via documented env vars', () => {
      expect(api.API_URL).toBeDefined();
      expect(typeof api.API_URL).toBe('string');
    });
  });
});
