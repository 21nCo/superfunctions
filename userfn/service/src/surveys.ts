import { createHash } from 'node:crypto';
import type { AuthSession } from '@superfunctions/auth';
import type { Adapter } from '@superfunctions/db';
import type { Route } from '@superfunctions/http';
import type { Question } from 'userfn';
import { canonical, object } from './validation.js';

export interface SurveyPolicy {
  enabled: boolean;
  questions: Question[];
  /** Maximum accepted responses for this verified user; defaults to one. */
  perUser?: number;
  /** Rolling interval (now-durationMs, now]; enforced in the same transaction as storage. */
  window?: { limit: number; durationMs: number };
}
export interface SurveyOptions {
  /** Trusted policy and audience decision. Return null when the user cannot access this survey. */
  resolvePolicy(session: AuthSession, surveyId: string): SurveyPolicy | null | Promise<SurveyPolicy | null>;
}
interface StoredResponse { id: string; fingerprint: string; surveyId: string; submittedAt: number; }
interface Counter { id: string; count: number; lastSubmittedAt: number; }
const eq = (field: string, value: string | number) => ({ field, operator: 'eq' as const, value });
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const integer = (value: unknown, max: number) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max;
const receipt = (row: StoredResponse) => ({ id: row.id, surveyId: row.surveyId, submittedAt: row.submittedAt, accepted: true });

function validatePolicy(policy: SurveyPolicy) {
  if (typeof policy.enabled !== 'boolean' || (policy.perUser !== undefined && !integer(policy.perUser, 1000000)) || !Array.isArray(policy.questions) || policy.questions.length > 100) throw new Error('Invalid survey policy');
  if (policy.window !== undefined && (!object(policy.window) || Object.keys(policy.window).some(key => !['limit', 'durationMs'].includes(key)) || !integer(policy.window.limit, 1000) || !integer(policy.window.durationMs, 8640000000000000) || policy.window.durationMs === 0)) throw new Error('Invalid survey window');
  const ids = new Set<string>();
  for (const question of policy.questions) {
    if (!object(question) || !validId(question.id) || ids.has(question.id) || !['nps', 'csat', 'text', 'choice'].includes(question.type) || (question.required !== undefined && typeof question.required !== 'boolean')) throw new Error('Invalid survey question');
    ids.add(question.id);
    if (question.type === 'choice' && (!Array.isArray(question.choices) || question.choices.length === 0 || question.choices.length > 100 || question.choices.some(choice => !object(choice) || !['string', 'number', 'boolean'].includes(typeof choice.value) || (typeof choice.value === 'number' && !Number.isFinite(choice.value))))) throw new Error('Invalid survey choices');
    if (question.type === 'nps' || question.type === 'csat') {
      const min = question.min ?? (question.type === 'nps' ? 0 : 1), max = question.max ?? (question.type === 'nps' ? 10 : 5);
      if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min > max) throw new Error('Invalid survey scale');
    }
  }
}
function validAnswers(answers: unknown[], policy: SurveyPolicy): boolean {
  const seen = new Set<string>();
  for (const answer of answers) {
    if (!object(answer) || Object.keys(answer).some(key => !['questionId', 'value'].includes(key)) || !validId(answer.questionId) || seen.has(answer.questionId)) return false;
    seen.add(answer.questionId);
    const question = policy.questions.find(question => question.id === answer.questionId);
    if (!question) return false;
    const value = answer.value;
    if (question.type === 'text' && (typeof value !== 'string' || value.length > 10000 || (question.required && !value.trim()))) return false;
    if (question.type === 'choice' && !question.choices!.some(choice => choice.value === value)) return false;
    if (question.type === 'nps' || question.type === 'csat') {
      const min = question.min ?? (question.type === 'nps' ? 0 : 1), max = question.max ?? (question.type === 'nps' ? 10 : 5);
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) return false;
    }
  }
  return policy.questions.every(question => !question.required || seen.has(question.id));
}

export function surveyRoutes(database: Adapter, authorize: (request: Request, scope: string) => Promise<AuthSession | Response>, options?: SurveyOptions): Route[] {
  if (!options) return [];
  if (!database.capabilities.transactions.supported) throw new Error('Durable surveys require database transactions');
  return [
    { method: 'OPTIONS', path: '/surveys/:surveyId/responses', handler: () => new Response(null, { status: 204 }) },
    { method: 'POST', path: '/surveys/:surveyId/responses', handler: async (request, context) => {
      const session = await authorize(request, 'userfn:surveys:write'); if (session instanceof Response) return session;
      if (session.subject.actorType !== 'user') return json({ error: 'A verified user identity is required' }, 403);
      const surveyId = context.params.surveyId, key = request.headers.get('idempotency-key');
      const body = await context.json();
      if (!validId(surveyId) || !validId(key) || !object(body) || Object.keys(body).some(key => key !== 'answers') || !Array.isArray(body.answers) || body.answers.length > 100) return json({ error: 'Invalid survey response' }, 400);
      const actor = [session.subject.tenantId, session.subject.actorId];
      const id = hash([...actor, key]), fingerprint = hash([surveyId, body.answers]);
      const counterId = hash([...actor, surveyId]);
      const previous = await database.findOne<StoredResponse>({ model: 'userfn_survey_responses', where: [eq('id', id)] });
      if (previous) return previous.fingerprint === fingerprint ? json(receipt(previous)) : json({ error: 'Survey key already used' }, 409);
      const resolved = await options.resolvePolicy(session, surveyId);
      if (!resolved) return json({ error: 'Survey not found' }, 404);
      const policy = structuredClone(resolved);
      validatePolicy(policy);
      if (!validAnswers(body.answers, policy)) return json({ error: 'Invalid survey answers' }, 400);
      for (let attempt = 0; attempt < 8; attempt++) {
        try {
          return await database.transaction(async tx => {
            const old = await tx.findOne<StoredResponse>({ model: 'userfn_survey_responses', where: [eq('id', id)] });
            if (old) return old.fingerprint === fingerprint ? json(receipt(old)) : json({ error: 'Survey key already used' }, 409);
            if (!policy.enabled) return json({ error: 'Survey is disabled' }, 403);
            const now = Date.now();
            if (!integer(now, 8640000000000000)) throw new Error('Invalid survey clock');
            const counter = await tx.findOne<Counter>({ model: 'userfn_survey_counters', where: [eq('id', counterId)] });
            if (counter && now < counter.lastSubmittedAt) return json({ error: 'Survey clock moved backwards' }, 503);
            if ((counter?.count ?? 0) >= (policy.perUser ?? 1)) return json({ error: 'Survey response cap reached' }, 429);
            if (policy.window) {
              const recent = await tx.findMany({ model: 'userfn_survey_responses', where: [eq('counterId', counterId), { field: 'submittedAt', operator: 'gt', value: now - policy.window.durationMs }], select: ['id'], limit: Math.max(1, policy.window.limit) });
              if (recent.length >= policy.window.limit) return json({ error: 'Survey window cap reached' }, 429);
            }
            if (!counter) await tx.create({ model: 'userfn_survey_counters', data: { id: counterId, count: 1, lastSubmittedAt: now } });
            else if (await tx.updateMany({ model: 'userfn_survey_counters', where: [eq('id', counterId), eq('count', counter.count)], data: { count: counter.count + 1, lastSubmittedAt: now } }) !== 1) throw new Error('Survey contention');
            const value = { id, fingerprint, counterId, surveyId, tenantId: session.subject.tenantId!, actorId: session.subject.actorId, answers: body.answers, submittedAt: now };
            await tx.create({ model: 'userfn_survey_responses', data: value });
            return json(receipt(value), 201);
          });
        } catch (error) {
          if (attempt === 7) throw error;
          await new Promise(resolve => setTimeout(resolve, attempt * 5));
        }
      }
      throw new Error('Survey storage unavailable');
    } },
  ];
}
