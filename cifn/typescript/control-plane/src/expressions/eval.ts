/**
 * Deterministic boolean expression evaluation for job/step `if` conditions.
 * Supports: ==, !=, &&, ||, !, parentheses; github.*, secrets.*; success(), failure(), always().
 * Rejects expressions > 2048 chars or unsupported syntax (PIPELINE_INVALID at validation time).
 */

import type { EvalContext } from './types.js';
import { EXPR_MAX_LENGTH } from './types.js';

const PIPELINE_INVALID_CODE = 'PIPELINE_INVALID';

function reject(message: string): never {
  const err = new Error(message) as Error & { code?: string };
  err.code = PIPELINE_INVALID_CODE;
  throw err;
}

function checkLength(expr: string): void {
  const len = Buffer.byteLength(expr, 'utf8');
  if (len > EXPR_MAX_LENGTH) {
    reject(
      `Expression exceeds maximum length of ${EXPR_MAX_LENGTH} characters (actual: ${len})`,
    );
  }
}

/** Tokenize: identifiers, string literals, operators, parens. No Date.now / randomness. */
function tokenize(expr: string): string[] {
  const s = expr.trim();
  const tokens: string[] = [];
  let i = 0;

  while (i < s.length) {
    if (/\s/.test(s[i])) {
      i++;
      continue;
    }
    if (s[i] === '(' || s[i] === ')' || s[i] === '!') {
      tokens.push(s[i]);
      i++;
      continue;
    }
    if (s[i] === '=' && s[i + 1] === '=') {
      tokens.push('==');
      i += 2;
      continue;
    }
    if (s[i] === '!' && s[i + 1] === '=') {
      tokens.push('!=');
      i += 2;
      continue;
    }
    if (s[i] === '&' && s[i + 1] === '&') {
      tokens.push('&&');
      i += 2;
      continue;
    }
    if (s[i] === '|' && s[i + 1] === '|') {
      tokens.push('||');
      i += 2;
      continue;
    }
    if (s[i] === "'") {
      let end = i + 1;
      while (end < s.length && s[end] !== "'") {
        if (s[end] === '\\') end++;
        end++;
      }
      if (end >= s.length) reject('Unclosed string literal');
      tokens.push(s.slice(i, end + 1));
      i = end + 1;
      continue;
    }
    if (/[a-zA-Z_.]/.test(s[i])) {
      let start = i;
      while (i < s.length && /[a-zA-Z0-9_.]/.test(s[i])) i++;
      tokens.push(s.slice(start, i));
      continue;
    }
    reject(`Unsupported character or operator in expression: ${s[i]}`);
  }

  return tokens;
}

/** Synchronous condition evaluation. Supports only success(), failure(), always(), github.*. No secrets. */
export function evaluateConditionSync(expr: string, context: EvalContext): boolean {
  checkLength(expr);
  const tokens = tokenize(expr);
  if (tokens.length === 0) return true;

  let pos = 0;

  function parseOr(): boolean {
    let left = parseAnd();
    while (tokens[pos] === '||') {
      pos++;
      left = left || parseAnd();
    }
    return left;
  }

  function parseAnd(): boolean {
    let left = parseNot();
    while (tokens[pos] === '&&') {
      pos++;
      left = left && parseNot();
    }
    return left;
  }

  function parseNot(): boolean {
    if (tokens[pos] === '!') {
      pos++;
      return !parseNot();
    }
    return parseCompare();
  }

  function parseCompare(): boolean {
    const left = parsePrimary();
    const op = tokens[pos];
    if (op === '==' || op === '!=') {
      pos++;
      const right = parsePrimary();
      if (op === '==') return String(left) === String(right);
      return String(left) !== String(right);
    }
    if (typeof left !== 'boolean') {
      reject('Unsupported expression: comparison or boolean operator required');
    }
    return left;
  }

  function resolveIdentifier(id: string): string | boolean {
    if (id === 'success') {
      const outcomes = context.stepOutcomes ?? [];
      return !outcomes.some(s => s === 'failure');
    }
    if (id === 'failure') {
      const outcomes = context.stepOutcomes ?? [];
      return outcomes.some(s => s === 'failure');
    }
    if (id === 'always') return true;
    if (id.startsWith('github.')) {
      const key = id.slice(7);
      const allowed = ['ref', 'repository', 'sha', 'event_name'];
      if (!allowed.includes(key)) reject(`Unsupported github field: ${key}`);
      const v = context.github?.[key as keyof NonNullable<EvalContext['github']>];
      return typeof v === 'string' ? v : '';
    }
    if (id.startsWith('secrets.')) {
      reject('secrets.* in condition requires async evaluation; use evaluateConditionAsync');
    }
    reject(`Unsupported expression identifier: ${id}`);
  }

  function parsePrimary(): boolean | string {
    const t = tokens[pos];
    if (t === '(') {
      pos++;
      const inner = parseOr();
      if (tokens[pos] !== ')') reject('Missing closing parenthesis');
      pos++;
      return inner;
    }
    if (t === 'success' || t === 'failure' || t === 'always') {
      const fn = t;
      pos++;
      if (tokens[pos] !== '(') reject(`Expected ( after ${fn}`);
      pos++;
      if (tokens[pos] !== ')') reject(`Expected ) for ${fn}()`);
      pos++;
      return resolveIdentifier(fn) as boolean;
    }
    if (t.startsWith("'") && t.endsWith("'")) {
      pos++;
      return t.slice(1, -1).replace(/\\'/g, "'");
    }
    if (/^[a-zA-Z_]/.test(t)) {
      const id = t;
      pos++;
      return resolveIdentifier(id) as string;
    }
    reject(`Unexpected token: ${t}`);
  }

  const result = parseOr();
  if (pos !== tokens.length) reject('Unexpected tokens after expression');
  return typeof result === 'boolean' ? result : reject('Expression did not evaluate to boolean');
}

/** Async condition evaluation; supports secrets.* when getSecret is provided. */
export async function evaluateConditionAsync(expr: string, context: EvalContext): Promise<boolean> {
  checkLength(expr);
  const tokens = tokenize(expr);
  if (tokens.length === 0) return true;

  let pos = 0;

  async function parseOr(): Promise<boolean> {
    let left = await parseAnd();
    while (tokens[pos] === '||') {
      pos++;
      left = left || (await parseAnd());
    }
    return left;
  }

  async function parseAnd(): Promise<boolean> {
    let left = await parseNot();
    while (tokens[pos] === '&&') {
      pos++;
      left = left && (await parseNot());
    }
    return left;
  }

  async function parseNot(): Promise<boolean> {
    if (tokens[pos] === '!') {
      pos++;
      return !(await parseNot());
    }
    return parseCompare();
  }

  async function parseCompare(): Promise<boolean> {
    const left = await parsePrimary();
    const op = tokens[pos];
    if (op === '==' || op === '!=') {
      pos++;
      const right = await parsePrimary();
      if (op === '==') return String(left) === String(right);
      return String(left) !== String(right);
    }
    if (typeof left !== 'boolean') {
      reject('Unsupported expression: comparison or boolean operator required');
    }
    return left;
  }

  async function resolveIdentifier(id: string): Promise<string | boolean> {
    if (id === 'success') {
      const outcomes = context.stepOutcomes ?? [];
      return !outcomes.some(s => s === 'failure');
    }
    if (id === 'failure') {
      const outcomes = context.stepOutcomes ?? [];
      return outcomes.some(s => s === 'failure');
    }
    if (id === 'always') return true;
    if (id.startsWith('github.')) {
      const key = id.slice(7);
      const allowed = ['ref', 'repository', 'sha', 'event_name'];
      if (!allowed.includes(key)) reject(`Unsupported github field: ${key}`);
      const v = context.github?.[key as keyof NonNullable<EvalContext['github']>];
      return typeof v === 'string' ? v : '';
    }
    if (id.startsWith('secrets.')) {
      const name = id.slice(8);
      const getSecret = context.getSecret;
      if (!getSecret) return '';
      const v = await getSecret(name);
      return v ?? '';
    }
    reject(`Unsupported expression identifier: ${id}`);
  }

  async function parsePrimary(): Promise<boolean | string> {
    const t = tokens[pos];
    if (t === '(') {
      pos++;
      const inner = await parseOr();
      if (tokens[pos] !== ')') reject('Missing closing parenthesis');
      pos++;
      return inner;
    }
    if (t === 'success' || t === 'failure' || t === 'always') {
      const fn = t;
      pos++;
      if (tokens[pos] !== '(') reject(`Expected ( after ${fn}`);
      pos++;
      if (tokens[pos] !== ')') reject(`Expected ) for ${fn}()`);
      pos++;
      return resolveIdentifier(fn) as Promise<boolean>;
    }
    if (t.startsWith("'") && t.endsWith("'")) {
      pos++;
      return t.slice(1, -1).replace(/\\'/g, "'");
    }
    if (/^[a-zA-Z_]/.test(t)) {
      const id = t;
      pos++;
      return resolveIdentifier(id);
    }
    reject(`Unexpected token: ${t}`);
  }

  const result = await parseOr();
  if (pos !== tokens.length) reject('Unexpected tokens after expression');
  return typeof result === 'boolean' ? result : reject('Expression did not evaluate to boolean');
}

/** Validate expression (length + parse). Throws with code PIPELINE_INVALID on error. */
export function validateExpression(expr: string): void {
  checkLength(expr);
  const tokens = tokenize(expr);
  if (tokens.length === 0) return;
  let pos = 0;

  function parseOr(): void {
    parseAnd();
    while (tokens[pos] === '||') {
      pos++;
      parseAnd();
    }
  }

  function parseAnd(): void {
    parseNot();
    while (tokens[pos] === '&&') {
      pos++;
      parseNot();
    }
  }

  function parseNot(): void {
    if (tokens[pos] === '!') {
      pos++;
      parseNot();
      return;
    }
    parseCompare();
  }

  function parseCompare(): void {
    parsePrimary();
    const op = tokens[pos];
    if (op === '==' || op === '!=') {
      pos++;
      parsePrimary();
    }
  }

  function parsePrimary(): void {
    const t = tokens[pos];
    if (t === '(') {
      pos++;
      parseOr();
      if (tokens[pos] !== ')') reject('Missing closing parenthesis');
      pos++;
      return;
    }
    if (t === 'success' || t === 'failure' || t === 'always') {
      pos++;
      if (tokens[pos] !== '(') reject(`Expected ( after ${t}`);
      pos++;
      if (tokens[pos] !== ')') reject(`Expected ) for ${t}()`);
      pos++;
      return;
    }
    if (t.startsWith("'") && t.endsWith("'")) {
      pos++;
      return;
    }
    if (t.startsWith('github.')) {
      const key = t.slice(7);
      const allowed = ['ref', 'repository', 'sha', 'event_name'];
      if (!allowed.includes(key)) reject(`Unsupported github field: ${key}`);
      pos++;
      return;
    }
    if (t.startsWith('secrets.')) {
      pos++;
      return;
    }
    reject(`Unsupported expression identifier: ${t}`);
  }

  parseOr();
  if (pos !== tokens.length) reject('Unexpected tokens after expression');
}

export { EXPR_MAX_LENGTH };
