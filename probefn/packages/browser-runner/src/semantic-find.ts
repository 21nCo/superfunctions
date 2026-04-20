import type { Locator, Page } from 'playwright';

import { createProbefnError } from '@probefn/contracts/errors';

import { extractPageModel, type PageModelElement } from './page-model.js';

const INTERACTABLE_ROLES = new Set([
  'button',
  'link',
  'checkbox',
  'radio',
  'textbox',
  'combobox',
  'switch',
  'tab',
  'menuitem',
]);

const ROLE_KEYWORDS = new Map<string, string>([
  ['button', 'button'],
  ['cta', 'button'],
  ['link', 'link'],
  ['checkbox', 'checkbox'],
  ['radio', 'radio'],
  ['textbox', 'textbox'],
  ['input', 'textbox'],
  ['field', 'textbox'],
  ['select', 'combobox'],
  ['dropdown', 'combobox'],
  ['combobox', 'combobox'],
]);

export interface SemanticQueryDescriptor {
  rawQuery: string;
  normalizedQuery: string;
  contentPhrase: string;
  contentTerms: string[];
  desiredRole?: string;
}

export interface SemanticCandidate {
  element: PageModelElement;
  semanticScore: number;
  matchedBy: string[];
}

export interface SemanticResolutionResult extends SemanticCandidate {
  locator: Locator;
}

export async function findSemanticCandidates(
  page: Page,
  query: string,
): Promise<SemanticCandidate[]> {
  const queryDescriptor = parseSemanticQuery(query);
  const pageModel = await extractPageModel(page);

  return pageModel.elements
    .filter(isInteractableElement)
    .map((element) => scoreSemanticCandidate(element, queryDescriptor))
    .filter((candidate): candidate is SemanticCandidate => candidate !== null)
    .sort((left, right) => right.semanticScore - left.semanticScore);
}

export async function resolveSemanticTarget(
  page: Page,
  query: string,
): Promise<SemanticResolutionResult> {
  const candidates = await findSemanticCandidates(page, query);
  if (candidates.length === 0) {
    throw createProbefnError({
      code: 'E_ACTION_TARGET_NOT_FOUND',
      message: 'No interactable element matched the provided query.',
      retryable: false,
      details: {
        query,
      },
    });
  }

  const highestScore = candidates[0]?.semanticScore ?? 0;
  const topCandidates = candidates.filter((candidate) => candidate.semanticScore === highestScore);
  if (topCandidates.length > 1) {
    throw createProbefnError({
      code: 'E_ACTION_AMBIGUOUS',
      message: 'Multiple interactable elements matched the provided query.',
      retryable: true,
      details: {
        query,
        candidateCount: topCandidates.length,
      },
    });
  }

  const [selected] = topCandidates;
  if (!selected) {
    throw createProbefnError({
      code: 'E_INTERNAL',
      message: 'Semantic resolution did not yield a candidate.',
      retryable: false,
    });
  }

  return {
    ...selected,
    locator: createLocatorForElement(page, selected.element),
  };
}

export function createLocatorForElement(
  page: Page,
  element: PageModelElement,
): Locator {
  if (element.selectorHints.id) {
    return page.locator(`[id="${escapeAttributeValue(element.selectorHints.id)}"]`);
  }

  if (element.selectorHints.testId) {
    return page.getByTestId(element.selectorHints.testId);
  }

  if (element.selectorHints.role && element.selectorHints.name) {
    return page.getByRole(element.selectorHints.role as Parameters<Page['getByRole']>[0], {
      name: element.selectorHints.name,
    });
  }

  if (element.name) {
    return page.getByText(element.name, {
      exact: true,
    });
  }

  if (element.text) {
    return page.getByText(element.text, {
      exact: true,
    });
  }

  throw createProbefnError({
    code: 'E_ACTION_TARGET_NOT_FOUND',
    message: 'No interactable element matched the provided query.',
    retryable: false,
  });
}

export function parseSemanticQuery(query: string): SemanticQueryDescriptor {
  const normalizedQuery = normalizeValue(query);
  const tokens = normalizedQuery.split(' ').filter(Boolean);
  const desiredRole = tokens.map((token) => ROLE_KEYWORDS.get(token)).find(Boolean);
  const contentTerms = tokens.filter((token) => !ROLE_KEYWORDS.has(token));
  const contentPhrase = contentTerms.join(' ');

  return {
    rawQuery: query,
    normalizedQuery,
    contentPhrase,
    contentTerms,
    ...(desiredRole ? { desiredRole } : {}),
  };
}

function scoreSemanticCandidate(
  element: PageModelElement,
  descriptor: SemanticQueryDescriptor,
): SemanticCandidate | null {
  const matchedBy: string[] = [];
  const normalizedRole = normalizeValue(element.role);
  const normalizedName = normalizeValue(element.name);
  const normalizedText = normalizeValue(element.text);
  const normalizedId = normalizeValue(element.selectorHints.id ?? '');
  const normalizedTestId = normalizeValue(element.selectorHints.testId ?? '');
  let semanticScore = 0;
  let matchedSemanticContent = false;

  if (descriptor.desiredRole) {
    if (normalizedRole !== descriptor.desiredRole) {
      return null;
    }

    semanticScore += 45;
    matchedBy.push('role');
  }

  if (descriptor.contentPhrase.length > 0) {
    if (normalizedName === descriptor.contentPhrase) {
      semanticScore += 120;
      matchedBy.push('accessible-name-exact');
      matchedSemanticContent = true;
    } else if (includesAllTerms(normalizedName, descriptor.contentTerms)) {
      semanticScore += 85;
      matchedBy.push('accessible-name');
      matchedSemanticContent = true;
    }

    if (normalizedText === descriptor.contentPhrase) {
      semanticScore += 55;
      matchedBy.push('text-exact');
      matchedSemanticContent = true;
    } else if (includesAllTerms(normalizedText, descriptor.contentTerms)) {
      semanticScore += 30;
      matchedBy.push('text');
      matchedSemanticContent = true;
    }

    if (
      includesAllTerms(normalizedId, descriptor.contentTerms) ||
      includesAllTerms(normalizedTestId, descriptor.contentTerms)
    ) {
      semanticScore += 20;
      matchedBy.push('locator-hint');
      matchedSemanticContent = true;
    }
  } else if (descriptor.desiredRole) {
    semanticScore += 10;
  }

  if (descriptor.contentTerms.length > 0 && !matchedSemanticContent) {
    return null;
  }

  if (matchedBy.length === 0 || semanticScore === 0) {
    return null;
  }

  return {
    element,
    semanticScore,
    matchedBy,
  };
}

function isInteractableElement(element: PageModelElement): boolean {
  return element.visible && !element.disabled && INTERACTABLE_ROLES.has(normalizeValue(element.role));
}

function includesAllTerms(haystack: string, terms: string[]): boolean {
  if (terms.length === 0) {
    return false;
  }

  return terms.every((term) => haystack.includes(term));
}

function normalizeValue(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function escapeAttributeValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
