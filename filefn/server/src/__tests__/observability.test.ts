import { describe, it, expect, vi } from 'vitest';
import { createLogger, redactSecrets, type LogContext } from '../index.js';

describe('@filefn/server observability', () => {
  describe('TV-OBS-LOG-NEG-001: Signed URLs are redacted in logs', () => {
    it('should redact AWS signed URLs with X-Amz-Signature', () => {
      const context: LogContext = {
        url: 'https://my-bucket.s3.amazonaws.com/files/file_123/ver_456?X-Amz-Signature=abc123def456',
        requestId: 'req_001',
      };

      const redacted = redactSecrets(context);

      expect(redacted.url).toBe('[REDACTED]');
      expect(redacted.requestId).toBe('[REDACTED]');
    });

    it('should redact URLs containing Signature parameter', () => {
      const context: LogContext = {
        downloadUrl: 'https://storage.example.com/path?Signature=secret123&expires=12345',
      };

      const redacted = redactSecrets(context);

      expect(redacted.downloadUrl).toBe('[REDACTED]');
    });

    it('should redact URLs containing token parameter', () => {
      const context: LogContext = {
        signedUrl: 'https://cdn.example.com/files/test.pdf?token=eyJhbGciOiJIUzI1NiJ9',
      };

      const redacted = redactSecrets(context);

      expect(redacted.signedUrl).toBe('[REDACTED]');
    });
  });

  describe('Logger redacts share tokens', () => {
    it('should redact keys containing "token"', () => {
      const context: LogContext = {
        shareToken: 'shr_abc123def456xyz',
        accessToken: 'jwt_token_here',
      };

      const redacted = redactSecrets(context);

      expect(redacted.shareToken).toBe('[REDACTED]');
      expect(redacted.accessToken).toBe('[REDACTED]');
    });

    it('should redact keys containing "secret"', () => {
      const context: LogContext = {
        apiSecret: 'my-secret-key',
        secretKey: 'another-secret',
      };

      const redacted = redactSecrets(context);

      expect(redacted.apiSecret).toBe('[REDACTED]');
      expect(redacted.secretKey).toBe('[REDACTED]');
    });

    it('should redact keys containing "password"', () => {
      const context: LogContext = {
        password: 'hunter2',
        userPassword: 'secret123',
      };

      const redacted = redactSecrets(context);

      expect(redacted.password).toBe('[REDACTED]');
      expect(redacted.userPassword).toBe('[REDACTED]');
    });

    it('should redact Bearer tokens in string values', () => {
      const context: LogContext = {
        authHeader: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
      };

      const redacted = redactSecrets(context);

      expect(redacted.authHeader).toBe('[REDACTED]');
    });
  });

  describe('Logger redacts long identifiers for safety', () => {
    it('should redact long requestId strings that could be secrets', () => {
      const context: LogContext = {
        requestId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      };

      const redacted = redactSecrets(context);

      expect(redacted.requestId).toBe('[REDACTED]');
    });

    it('should redact long fileId strings that could be secrets', () => {
      const context: LogContext = {
        fileId: 'f1234567-89ab-cdef-0123-456789abcdef',
      };

      const redacted = redactSecrets(context);

      expect(redacted.fileId).toBe('[REDACTED]');
    });

    it('should redact non-UUID values for known ID fields', () => {
      const context: LogContext = {
        fileId: 'file_123',
        uploadSessionId: 'upl_456',
        versionId: 'ver_789',
      };

      const redacted = redactSecrets(context);

      expect(redacted.fileId).toBe('[REDACTED]');
      expect(redacted.uploadSessionId).toBe('[REDACTED]');
      expect(redacted.versionId).toBe('[REDACTED]');
    });
  });

  describe('Logger handles nested objects', () => {
    it('should redact secrets in nested objects', () => {
      const context: LogContext = {
        request: {
          url: 'https://s3.amazonaws.com/bucket/key?X-Amz-Signature=secret',
          headers: {
            authorization: 'Bearer jwt.token.here',
          },
        },
      };

      const redacted = redactSecrets(context);

      expect((redacted.request as any).url).toBe('[REDACTED]');
      expect((redacted.request as any).headers.authorization).toBe('[REDACTED]');
    });
  });

  describe('Logger handles null and undefined', () => {
    it('should skip null values', () => {
      const context: LogContext = {
        fileId: null as any,
        requestId: undefined,
        value: 'test',
      };

      const redacted = redactSecrets(context);

      expect(redacted.fileId).toBeUndefined();
      expect(redacted.requestId).toBeUndefined();
      expect(redacted.value).toBe('test');
    });
  });

  describe('Logger preserves non-string values', () => {
    it('should preserve numbers', () => {
      const context: LogContext = {
        size: 1024,
        downloads: 5,
      };

      const redacted = redactSecrets(context);

      expect(redacted.size).toBe(1024);
      expect(redacted.downloads).toBe(5);
    });

    it('should preserve booleans', () => {
      const context: LogContext = {
        authenticated: true,
        expired: false,
      };

      const redacted = redactSecrets(context);

      expect(redacted.authenticated).toBe(true);
      expect(redacted.expired).toBe(false);
    });

    it('should preserve arrays', () => {
      const context: LogContext = {
        roles: ['admin', 'user'],
      };

      const redacted = redactSecrets(context);

      expect(redacted.roles).toEqual(['admin', 'user']);
    });
  });

  describe('createLogger', () => {
    it('should log with redacted secrets', () => {
      const outputs: Array<{ level: string; message: string; context: LogContext }> = [];

      const logger = createLogger({
        level: 'info',
        output: (level, message, context) => {
          outputs.push({ level, message, context });
        },
      });

      logger.info('File downloaded', {
        fileName: 'test.png',
        url: 'https://s3.amazonaws.com/bucket/key?X-Amz-Signature=secret',
      });

      expect(outputs.length).toBe(1);
      expect(outputs[0].level).toBe('info');
      expect(outputs[0].message).toBe('File downloaded');
      expect(outputs[0].context.url).toBe('[REDACTED]');
      expect(outputs[0].context.fileName).toBe('test.png');
    });

    it('should respect log level', () => {
      const outputs: string[] = [];

      const logger = createLogger({
        level: 'warn',
        output: (level, message) => {
          outputs.push(`${level}: ${message}`);
        },
      });

      logger.debug('debug message');
      logger.info('info message');
      logger.warn('warn message');
      logger.error('error message');

      expect(outputs).not.toContain('debug: debug message');
      expect(outputs).not.toContain('info: info message');
      expect(outputs).toContain('warn: warn message');
      expect(outputs).toContain('error: error message');
    });

    it('should include timestamp in logs', () => {
      let capturedContext: LogContext = {};

      const logger = createLogger({
        level: 'info',
        output: (level, message, context) => {
          capturedContext = context;
        },
      });

      logger.info('Test message');

      expect(capturedContext.timestamp).toBeDefined();
      expect(typeof capturedContext.timestamp).toBe('string');
    });

    it('should use console output by default', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const logger = createLogger({ level: 'info' });
      logger.info('Test message', { requestId: 'req_001' });

      expect(consoleSpy).toHaveBeenCalled();
      const loggedJson = consoleSpy.mock.calls[0][0];
      expect(loggedJson).toContain('Test message');

      consoleSpy.mockRestore();
    });

    it('should use console.error for error level', () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const logger = createLogger({ level: 'error' });
      logger.error('Error occurred');

      expect(consoleSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });

    it('should use console.warn for warn level', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const logger = createLogger({ level: 'warn' });
      logger.warn('Warning message');

      expect(consoleSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });

  describe('Redaction patterns', () => {
    it('should redact long random strings (potential secrets)', () => {
      const context: LogContext = {
        unknownField: 'this-is-a-very-long-random-string-that-looks-like-a-secret-key-abc123',
      };

      const redacted = redactSecrets(context);

      expect(redacted.unknownField).toBe('[REDACTED]');
    });

    it('should preserve short strings', () => {
      const context: LogContext = {
        fileName: 'test.png',
        mimeType: 'image/png',
        policy: 'user-avatar',
      };

      const redacted = redactSecrets(context);

      expect(redacted.fileName).toBe('test.png');
      expect(redacted.mimeType).toBe('image/png');
      expect(redacted.policy).toBe('user-avatar');
    });
  });

  describe('Logger methods', () => {
    it('should have all required log methods', () => {
      const logger = createLogger();

      expect(typeof logger.debug).toBe('function');
      expect(typeof logger.info).toBe('function');
      expect(typeof logger.warn).toBe('function');
      expect(typeof logger.error).toBe('function');
    });

    it('should handle empty context', () => {
      const outputs: LogContext[] = [];

      const logger = createLogger({
        level: 'debug',
        output: (level, message, context) => {
          outputs.push(context);
        },
      });

      logger.debug('No context');

      expect(outputs.length).toBe(1);
      expect(outputs[0].timestamp).toBeDefined();
    });
  });
});
