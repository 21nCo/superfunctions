/**
 * PHASE_13: Observability — TV-OBS-001, TV-OBS-002 (log redaction).
 */

import { describe, it, expect } from "vitest";
import { createLogger } from "../logging/logger.js";

describe("PHASE_13: Logging redaction", () => {
  describe("TV-OBS-001: logs redact doc bodies", () => {
    it("logMutation does not include raw doc body in sink output", () => {
      const logs: Array<{ level: string; message: string; meta: Record<string, unknown> }> = [];
      const logger = createLogger({
        sink: (level, message, meta) => logs.push({ level, message, meta: { ...meta } }),
      });
      logger.logMutation({
        action: "docs.patch",
        dataset: "prod",
        docId: "post-1",
        body: { title: "secret content", draft: true },
      });
      expect(logs.length).toBe(1);
      const meta = logs[0].meta;
      expect(meta.action).toBe("docs.patch");
      expect(meta.dataset).toBe("prod");
      expect(meta.docId).toBe("post-1");
      expect(meta.body).toBeUndefined();
      const str = JSON.stringify(logs[0]);
      expect(str).not.toContain("secret content");
    });
  });

  describe("TV-OBS-002: logs do not contain auth secrets", () => {
    it("logAuth does not include token or password in sink output", () => {
      const logs: Array<{ level: string; message: string; meta: Record<string, unknown> }> = [];
      const logger = createLogger({
        sink: (level, message, meta) => logs.push({ level, message, meta: { ...meta } }),
      });
      logger.logAuth({
        action: "login",
        subject: "user-1",
        token: "abc123secret",
        password: "super-secret",
      });
      expect(logs.length).toBe(1);
      const meta = logs[0].meta;
      expect(meta.action).toBe("login");
      expect(meta.subject).toBe("user-1");
      expect(meta.token).toBeUndefined();
      expect(meta.password).toBeUndefined();
      const str = JSON.stringify(logs[0]);
      expect(str).not.toContain("abc123secret");
      expect(str).not.toContain("super-secret");
    });
  });
});
