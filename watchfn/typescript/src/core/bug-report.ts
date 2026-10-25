import { z } from "zod";

// Validate without transforming the envelope persisted by the shared transport.
const requiredText = z.string().trim().min(1);
// Accept the existing minute precision and compact numeric offset forms while
// validating with Zod's current calendar/time rules. Preserve the wire value.
const timestamp = z.string().refine(value => {
  const normalized = value.replace(/([+-]\d{2})(\d{2})$/, "$1:$2")
    .replace(/(T\d{2}:\d{2})(Z|[+-]\d{2}:\d{2})$/, "$1:00$2");
  return z.iso.datetime({ offset: true }).safeParse(normalized).success;
}, "Invalid datetime");
export const bugReportSchema = z.object({
  id: requiredText,
  type: z.literal("bug_report"),
  timestamp,
  app: z.object({ name: requiredText, version: z.string().optional() }).passthrough(),
  sessionId: requiredText,
  report: z.object({
    title: requiredText, description: z.string().optional(), steps: z.array(z.string()).optional(),
    severity: z.enum(["low", "medium", "high", "critical"]), tags: z.array(z.string()).optional(),
  }).passthrough(),
  context: z.record(z.string(), z.unknown()),
  attachments: z.array(z.record(z.string(), z.unknown())).optional(),
  user: z.record(z.string(), z.unknown()).optional(), integration: z.record(z.string(), z.unknown()).optional(),
  replayId: z.string().optional(),
}).passthrough();

