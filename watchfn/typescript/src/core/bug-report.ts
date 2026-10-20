import { z } from "zod";

// Validate without transforming the envelope persisted by the shared transport.
const requiredText = z.string().trim().min(1);
export const bugReportSchema = z.object({
  id: requiredText,
  type: z.literal("bug_report"),
  timestamp: z.string().datetime({ offset: true }),
  app: z.object({ name: requiredText, version: z.string().optional() }).passthrough(),
  sessionId: requiredText,
  report: z.object({
    title: requiredText, description: z.string().optional(), steps: z.array(z.string()).optional(),
    severity: z.enum(["low", "medium", "high", "critical"]), tags: z.array(z.string()).optional(),
  }).passthrough(),
  context: z.record(z.unknown()),
  attachments: z.array(z.record(z.unknown())).optional(),
  user: z.record(z.unknown()).optional(), integration: z.record(z.unknown()).optional(),
  replayId: z.string().optional(),
}).passthrough();

