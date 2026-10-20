export class FeedbackValidationError extends Error {}
export class FeedbackConflictError extends Error {}
export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function invalid(): never { throw new FeedbackValidationError('Invalid feedback request'); }
function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) invalid();
}
export function canonical(value: unknown, depth = 0): string {
  if (depth > 20) invalid();
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(entry => canonical(entry, depth + 1)).join(',') + ']';
  if (object(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key], depth + 1)).join(',') + '}';
  return invalid();
}
export function validatePayload(value: unknown): Record<string, unknown> {
  if (!object(value)) invalid();
  keys(value, ['feedback', 'context']);
  const feedback = value.feedback;
  const context = value.context;
  if (!object(feedback) || !object(context)) invalid();
  keys(feedback, ['title', 'body', 'category', 'priority', 'tags', 'attachments', 'score', 'productArea']);
  keys(context, ['source', 'user']);
  if (!text(feedback.title, 200) || !text(feedback.body, 20000) ||
      !['bug', 'feature', 'general'].includes(feedback.category as string) || context.source !== 'in_app') invalid();
  if (feedback.productArea !== undefined && !text(feedback.productArea, 100)) invalid();
  if (feedback.priority !== undefined && !['low', 'medium', 'high'].includes(feedback.priority as string)) invalid();
  if (feedback.score !== undefined && (typeof feedback.score !== 'number' || !Number.isFinite(feedback.score))) invalid();
  for (const field of ['tags', 'attachments']) {
    const values = feedback[field];
    if (values !== undefined && (!Array.isArray(values) || values.length > 20 || values.some(entry => !text(entry, field === 'tags' ? 64 : 32768)))) invalid();
  }
  if (context.user !== null) {
    if (!object(context.user)) invalid();
    keys(context.user, ['id', 'traits']);
    if (!text(context.user.id, 200) || !object(context.user.traits)) invalid();
  }
  canonical(value); // Enforce bounded depth and JSON-only metadata before persistence.
  return value;
}
export function validateKey(value: string): string {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(value)) throw new FeedbackValidationError('Invalid Idempotency-Key');
  return value;
}
