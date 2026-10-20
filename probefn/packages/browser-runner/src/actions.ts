import type { Locator, Page } from 'playwright';

import { createProbefnError } from '@probefn/contracts/errors';
import type { EventDeltaBaseline, EventDeltaSummary } from '@probefn/core';
import { captureEventDeltaBaseline, diffEventDeltaSummary } from '@probefn/core';

import { settleAction, validateActionSettlement, type ActionSettlementOptions } from './action-settlement.js';
import { confirmDomInteractable } from './confirmation.js';
import { createLocatorForElement, findSemanticCandidates } from './semantic-find.js';
import { snapshotLocatorElement } from './page-model.js';
import { rankVisionCandidates } from './vision-ranker.js';

export type DeterministicActionKind = 'click' | 'fill' | 'select' | 'hover' | 'press';

export interface DeterministicAction {
  kind: DeterministicActionKind;
  target: {
    selector?: string;
    query?: string;
    requireDomConfirmation?: boolean;
  };
  value?: string;
  key?: string;
}

export interface DeterministicActionResult extends EventDeltaSummary {
  action: DeterministicActionKind;
  targetElementId: string;
  checkpointId: string | null;
}

export interface PerformDeterministicActionOptions extends ActionSettlementOptions {
  repoRoot: string;
  page: Page;
  action: DeterministicAction;
  eventPaths: {
    consoleSinkPath?: string;
    pageErrorSinkPath?: string;
    networkSinkPath?: string;
  };
}

export interface PageActionResult extends EventDeltaSummary {
  action: DeterministicActionKind;
  targetElementId: string;
  checkpointId: string | null;
  usedVisionAssist: boolean;
}

type DeterministicAriaRole = Parameters<Page['getByRole']>[0];

export async function performDeterministicAction(
  options: PerformDeterministicActionOptions,
): Promise<DeterministicActionResult> {
  const selector = options.action.target.selector;
  if (!selector) {
    throw createProbefnError({
      code: 'E_CONFIG_INVALID',
      message: 'Deterministic actions require a selector in this phase.',
      retryable: false,
    });
  }

  const locator = resolveDeterministicLocator(options.page, selector);
  const count = await locator.count();
  if (count === 0) {
    throw createProbefnError({
      code: 'E_ACTION_TARGET_NOT_FOUND',
      message: `No element matched selector ${selector}.`,
      retryable: false,
    });
  }

  const target = locator.first();
  validateActionSettlement(options);
  await options.flushEvents?.();
  const before = await captureEventDeltaBaseline(options.repoRoot, options.eventPaths);

  const targetSnapshot = await snapshotLocatorElement(target);
  await settleAction(options.page, options, () => executeActionOnLocator(target, options.action, {
    notInteractableMessage: `Element matched selector ${selector} but is not safely interactable.`,
    details: {
      selector,
    },
  }));

  const after = await captureEventDeltaBaseline(options.repoRoot, options.eventPaths);
  return {
    action: options.action.kind,
    targetElementId: targetSnapshot.elementId,
    checkpointId: null,
    ...diffEventDeltaSummary(before, after),
  };
}

export async function performPageAction(
  options: PerformDeterministicActionOptions,
): Promise<PageActionResult> {
  if (options.action.target.selector) {
    const deterministicResult = await performDeterministicAction(options);
    return {
      ...deterministicResult,
      usedVisionAssist: false,
    };
  }

  const query = options.action.target.query;
  if (!query) {
    throw createProbefnError({
      code: 'E_CONFIG_INVALID',
      message: 'Page actions require either a selector or a query.',
      retryable: false,
    });
  }

  const candidates = await findSemanticCandidates(options.page, query);
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
  let selectedCandidate = topCandidates[0];
  let usedVisionAssist = false;

  if (topCandidates.length > 1) {
    if (options.action.target.requireDomConfirmation !== true) {
      throw createProbefnError({
        code: 'E_CONFIG_INVALID',
        message: 'Vision-assisted actions must require DOM confirmation.',
        retryable: false,
      });
    }

    const rankedCandidates = await rankVisionCandidates(options.page, query, topCandidates);
    selectedCandidate = rankedCandidates[0]?.candidate;
    usedVisionAssist = true;
  }

  if (!selectedCandidate) {
    throw createProbefnError({
      code: 'E_INTERNAL',
      message: 'Page action did not resolve to a target.',
      retryable: false,
    });
  }

  const locator = createLocatorForElement(options.page, selectedCandidate.element);
  if (usedVisionAssist) {
    const confirmation = await confirmDomInteractable(locator.first());
    if (!confirmation.ok) {
      throw createProbefnError({
        code: 'E_ACTION_NOT_INTERACTABLE',
        message: 'Matched element is not safely interactable after DOM confirmation.',
        retryable: true,
        details: {
          query,
          usedVisionAssist: true,
        },
      });
    }
  }

  validateActionSettlement(options);
  await options.flushEvents?.();
  const before = await captureEventDeltaBaseline(options.repoRoot, options.eventPaths);
  const targetSnapshot = await snapshotLocatorElement(locator.first());
  await settleAction(options.page, options, () => executeActionOnLocator(locator.first(), options.action, {
    notInteractableMessage: usedVisionAssist
      ? 'Matched element is not safely interactable after DOM confirmation.'
      : 'Matched element is not safely interactable.',
    details: {
      query,
      usedVisionAssist,
    },
  }));
  const after = await captureEventDeltaBaseline(options.repoRoot, options.eventPaths);

  return {
    action: options.action.kind,
    targetElementId: targetSnapshot.elementId,
    checkpointId: null,
    usedVisionAssist,
    ...diffEventDeltaSummary(before, after),
  };
}

export async function captureActionDeltaBaseline(
  repoRoot: string,
  eventPaths: {
    consoleSinkPath?: string;
    pageErrorSinkPath?: string;
    networkSinkPath?: string;
  },
): Promise<EventDeltaBaseline> {
  return captureEventDeltaBaseline(repoRoot, eventPaths);
}

function isInteractableFailure(error: unknown): boolean {
  if (error instanceof Error) {
    return /not visible|not enabled|not editable|intercepts pointer events|element is outside of the viewport|strict mode violation/i.test(error.message);
  }
  return false;
}

async function assertInteractable(
  target: Locator,
  action: DeterministicAction,
): Promise<void> {
  if (!(await target.isVisible())) {
    throw new Error('Target is not visible.');
  }

  if (action.kind === 'fill') {
    if (!(await target.isEditable())) {
      throw new Error('Target is not editable.');
    }
    return;
  }

  if (action.kind === 'select' || action.kind === 'click' || action.kind === 'hover') {
    if (!(await target.isEnabled())) {
      throw new Error('Target is not enabled.');
    }
  }
}

async function executeActionOnLocator(
  locator: Locator,
  action: DeterministicAction,
  options: {
    notInteractableMessage: string;
    details: Record<string, string | boolean>;
  },
): Promise<void> {
  try {
    await assertInteractable(locator, action);
    switch (action.kind) {
      case 'click':
        await locator.click();
        return;
      case 'fill':
        if (action.value === undefined) {
          throw createProbefnError({
            code: 'E_CONFIG_INVALID',
            message: 'Fill actions require a value.',
            retryable: false,
          });
        }
        await locator.fill(action.value);
        return;
      case 'select':
        if (action.value === undefined) {
          throw createProbefnError({
            code: 'E_CONFIG_INVALID',
            message: 'Select actions require a value.',
            retryable: false,
          });
        }
        await locator.selectOption(action.value);
        return;
      case 'hover':
        await locator.hover();
        return;
      case 'press':
        if (!action.key) {
          throw createProbefnError({
            code: 'E_CONFIG_INVALID',
            message: 'Press actions require a key.',
            retryable: false,
          });
        }
        await locator.press(action.key);
        return;
    }
  } catch (error) {
    if (isInteractableFailure(error)) {
      throw createProbefnError({
        code: 'E_ACTION_NOT_INTERACTABLE',
        message: options.notInteractableMessage,
        retryable: true,
        details: options.details,
        cause: error,
      });
    }

    throw error;
  }
}

function resolveDeterministicLocator(page: Page, selector: string): Locator {
  if (selector.startsWith('label=')) {
    return page.getByLabel(normalizeExplicitValue(selector.slice('label='.length)));
  }

  if (selector.startsWith('testid=')) {
    return page.getByTestId(normalizeExplicitValue(selector.slice('testid='.length)));
  }

  if (selector.startsWith('testId=')) {
    return page.getByTestId(normalizeExplicitValue(selector.slice('testId='.length)));
  }

  if (selector.startsWith('role=')) {
    const parsedSelector = parseRoleSelector(selector);
    if (parsedSelector) {
      return page.getByRole(parsedSelector.role, {
        ...(parsedSelector.name ? { name: parsedSelector.name } : {}),
      });
    }
  }

  return page.locator(selector);
}

function parseRoleSelector(
  selector: string,
): { role: DeterministicAriaRole; name?: string } | null {
  const match = /^role=([a-z0-9_-]+)(?:\[name=(.+)\])?$/i.exec(selector);
  if (!match) {
    return null;
  }

  const [, role, name] = match;
  return {
    role: role as DeterministicAriaRole,
    ...(name ? { name: normalizeExplicitValue(name) } : {}),
  };
}

function normalizeExplicitValue(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith('\'') && trimmed.endsWith('\''))
  ) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}
